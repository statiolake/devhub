// @vitest-environment jsdom

/**
 * What keeps a sent message from moving once it has landed
 * (docs/motion.md, "Reserved space for late content"). jsdom lays nothing
 * out, so these hold the structure that decides the heights: whatever
 * replaces something has the same parts, and whatever comes and goes keeps
 * its room. The heights themselves were measured in the running app.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../model/conversation";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { assistant, put, transcriptOf, user } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(cleanup);

const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};

const sending = (text: string): ConversationEvent => ({
  type: "sending",
  sending: [{ id: "s1", text, images: [], origin: "person" }],
});

/** An element's shape: its classes, and its children's, depth first. */
function shape(element: Element): string {
  return `${element.className}(${[...element.children].map(shape).join(",")})`;
}

/** The parts of a message's row that decide its height: bubble and actions. */
function rows(element: Element): string[] {
  const message = element.querySelector(".conversation-user")!;
  return [...message.children].map((child) => child.className);
}

describe("a sent message", () => {
  it("is drawn while it is sent with the parts its echo has", () => {
    const view = draw(transcriptOf([put(user("u1", "hi")), sending("again")]));
    const bubble = entry("sending:s1");
    view.redraw(
      transcriptOf([put(user("u1", "hi")), put(user("u2", "again"))]),
    );
    expect(rows(bubble)).toEqual(rows(entry("u2")));
  });

  it("is spaced as its echo is, after the chunks", () => {
    draw(transcriptOf([put(user("u1", "hi")), sending("again")]));
    const bubble = entry("sending:s1");
    // Its spacing is by the chunks' container before it (conversation.css).
    expect(bubble.previousElementSibling).toHaveClass("conversation-chunks");
    expect(bubble).toHaveAttribute("data-kind", "user");
  });

  it("keeps Copy where it is when Rewind comes and goes with the turn", () => {
    const idle = transcriptOf([
      put(user("u1", "hi")),
      put(assistant("a1", "ok")),
    ]);
    const view = draw(idle);
    const actions = () =>
      entry("u1").querySelector(".conversation-message-actions")!;
    expect(actions().lastElementChild).toHaveClass("conversation-copy");
    view.redraw(
      transcriptOf([
        put(user("u1", "hi")),
        put(assistant("a1", "ok")),
        RUNNING,
      ]),
    );
    expect(actions().lastElementChild).toHaveClass("conversation-copy");
  });
});

describe("an answer", () => {
  it("has its Copy row from its first block of text, before any word", () => {
    draw(
      transcriptOf([
        put(user("u1", "hi")),
        put(assistant("a1", "", { streaming: true })),
        RUNNING,
      ]),
    );
    expect(
      entry("a1").querySelector(".conversation-message-actions"),
    ).not.toBeNull();
  });
});

describe("the activity line's room", () => {
  it("is kept while no turn runs, where the line stands while one does", () => {
    const history = [put(user("u1", "hi")), put(assistant("a1", "ok"))];
    const view = draw(transcriptOf(history));
    const transcript = document.querySelector(".conversation-transcript")!;
    const last = () =>
      shape(transcript.querySelector(":scope > :nth-last-child(1)")!);
    expect(last()).toBe("conversation-activity-slot()");
    view.redraw(transcriptOf([...history, RUNNING]));
    expect(transcript.lastElementChild).toHaveClass("conversation-activity");
    expect(transcript.querySelector(".conversation-activity-slot")).toBeNull();
  });
});
