// @vitest-environment jsdom

/**
 * A GUI Agent's transcript is text to read and quote: the page's selection
 * guard lets a selection start anywhere in it — an answer, a code block, a
 * subagent's pane — and nowhere in the chrome around it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isSelectable } from "../selection";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { assistant, put, tool, transcriptOf } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(cleanup);

const SESSION = transcriptOf([
  put(assistant("a1", "Some prose.\n\n```ts\nconst answer = 42;\n```")),
  put(
    tool("task", "Task: look", {
      name: "Task",
      status: "running",
      spawns: {
        label: "Look",
        prompt: "look around",
        model: undefined,
        state: "running",
      },
    }),
  ),
  put(assistant("inner", "found it", { parent: "task" })),
]);

describe("selecting text in a GUI Agent", () => {
  it("starts in an answer's prose and in its code", () => {
    draw(SESSION);
    const prose = entry("a1").querySelector("p")!.firstChild!;
    const code = entry("a1").querySelector("pre code")!;
    expect(isSelectable(prose)).toBe(true);
    expect(isSelectable(code)).toBe(true);
  });

  it("starts in a subagent's work, whether inline or filling the pane", () => {
    draw(SESSION);
    expect(isSelectable(entry("inner"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Look" }));
    expect(isSelectable(entry("inner"))).toBe(true);
  });

  it("does not start in the chrome around it", () => {
    draw(SESSION);
    expect(isSelectable(document.querySelector(".conversation-header"))).toBe(
      false,
    );
    expect(
      isSelectable(document.querySelector(".conversation-composer-toolbar")),
    ).toBe(false);
  });
});
