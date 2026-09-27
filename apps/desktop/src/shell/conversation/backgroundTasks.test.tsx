// @vitest-environment jsdom

/**
 * What the Agent has working in the background, under the composer: a quiet
 * line while anything is, opened into a list whose each line goes to the call
 * that started it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyEvent,
  entryId,
  type ConversationEvent,
  type RunningTask,
} from "../../model/conversation";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { put, tool, transcriptOf } from "./transcriptFixtures";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const SERVER: RunningTask = {
  id: "b1",
  kind: "shell",
  title: "Start the dev server",
  call: entryId("tool:dev"),
};
const RESEARCH: RunningTask = {
  id: "a1",
  kind: "subagent",
  title: "Research the parser",
  call: undefined,
};

function running(...tasks: RunningTask[]): ConversationEvent {
  return { type: "background-tasks", tasks };
}

function withTasks(...tasks: RunningTask[]) {
  return transcriptOf([
    put(
      tool("tool:dev", "Bash: npm run dev", {
        input: { command: "npm run dev", run_in_background: true },
        background: { state: "running", summary: undefined },
      }),
    ),
    running(...tasks),
  ]);
}

function toggle(): HTMLElement {
  return screen.getByRole("button", { name: /background tasks?$/ });
}

describe("the background tasks line", () => {
  it("is not drawn while nothing works in the background", () => {
    draw(withTasks());
    expect(document.querySelector(".conversation-background")).toBeNull();
  });

  it("says how many and what they are, folded, beside the context readout", () => {
    draw(withTasks(SERVER, RESEARCH));
    expect(toggle()).toHaveAccessibleName("2 background tasks");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent(
      "Start the dev server, Research the parser",
    );
    expect(screen.queryByRole("list", { name: "Background tasks" })).toBeNull();
    expect(toggle().closest(".conversation-footer")?.parentElement).toHaveClass(
      "conversation-composer",
    );
  });

  it("opens into a list of each task's title, kind and state", () => {
    draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "Background tasks" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Start the dev servershellRunning",
      "Research the parsersubagentRunning",
    ]);
  });

  it("lets a task go once it has ended, and goes away with the last", () => {
    const both = withTasks(SERVER, RESEARCH);
    const view = draw(both);
    fireEvent.click(toggle());
    const one = applyEvent(both, running(RESEARCH));
    view.redraw(one);
    expect(toggle()).toHaveAccessibleName("1 background task");
    const list = screen.getByRole("list", { name: "Background tasks" });
    expect(list).not.toHaveTextContent("Start the dev server");
    view.redraw(applyEvent(one, running()));
    expect(document.querySelector(".conversation-background")).toBeNull();
  });

  it("goes to the call that started a task, opened, and has nowhere to go before the CLI names it", () => {
    draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    const call = entry("tool:dev");
    const fold = call.querySelector("details.conversation-tool");
    expect(fold).not.toHaveAttribute("open");
    fireEvent.click(
      screen.getByRole("button", { name: /Start the dev server/ }),
    );
    expect(fold).toHaveAttribute("open");
    expect(call.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(fold?.querySelector("summary"));
    // The subagent's call is not known yet: its line is words, not a button.
    expect(
      screen.queryByRole("button", { name: /Research the parser/ }),
    ).toBeNull();
    expect(
      screen.getByRole("list", { name: "Background tasks" }),
    ).toHaveTextContent("Research the parser");
  });
});
