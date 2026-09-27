// @vitest-environment jsdom

/**
 * What the Agent has working in the background, under the composer: a quiet
 * line while anything is, opened into a list whose each line goes to the call
 * that started it.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyEvent,
  entryId,
  type ConversationEvent,
  type RunningTask,
} from "../../model/conversation";
import { elapsedText } from "./BackgroundTasks";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import { WIDE_PANE_PX } from "./SubagentPanes";
import {
  assistant,
  put,
  tool,
  transcriptOf,
  USAGE,
} from "./transcriptFixtures";

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
  startedAt: undefined,
  stoppable: true,
};
const RESEARCH: RunningTask = {
  id: "a1",
  kind: "subagent",
  title: "Research the parser",
  call: undefined,
  startedAt: undefined,
  stoppable: true,
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
    expect(
      document.querySelector(".conversation-background-toggle"),
    ).toBeNull();
    // The context readout's row is there all the same.
    expect(document.querySelector(".conversation-footer-row")).not.toBeNull();
  });

  it("says how many and what they are, folded, beside the context readout", () => {
    draw(withTasks(SERVER, RESEARCH));
    expect(toggle()).toHaveAccessibleName("2 background tasks");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent(
      "Start the dev server, Research the parser",
    );
    expect(screen.queryByRole("list", { name: "Background tasks" })).toBeNull();
    expect(toggle().parentElement).toHaveClass("conversation-footer-row");
    expect(toggle().closest(".conversation-footer")?.parentElement).toHaveClass(
      "conversation-composer",
    );
  });

  it("opens into a list of each task: its state as a call's glyph, its title and its kind", () => {
    draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "Background tasks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Start the dev servershell",
      "Research the parsersubagent",
    ]);
    for (const item of items) {
      const mark = within(item).getByRole("img");
      expect(mark).toHaveClass("conversation-tool-mark");
      expect(mark).toHaveAccessibleName("Running");
      // The glyph leads the line.
      expect(mark.parentElement!.firstElementChild).toBe(mark);
    }
  });

  it("opens under the row, across the composer's width, not beside the context readout", () => {
    draw(
      applyEvent(withTasks(SERVER, RESEARCH), {
        type: "usage",
        usage: { ...USAGE, contextTokens: 90_000, contextWindow: 200_000 },
      }),
    );
    fireEvent.click(toggle());
    const list = screen.getByRole("list", { name: "Background tasks" });
    const footer = list.parentElement!;
    expect(footer).toHaveClass("conversation-footer");
    const row = footer.querySelector(":scope > .conversation-footer-row")!;
    expect(row).toContainElement(toggle());
    expect(row.querySelector(".conversation-context")).not.toBeNull();
    expect(row).not.toContainElement(list);
    expect(row.nextElementSibling).toBe(list);
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
    expect(
      document.querySelector(".conversation-background-toggle"),
    ).toBeNull();
    expect(screen.queryByRole("list", { name: "Background tasks" })).toBeNull();
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

describe("a subagent among the background tasks", () => {
  const SURVEY: RunningTask = {
    id: "a2",
    kind: "subagent",
    title: "Survey the parsers",
    call: entryId("tool:survey"),
    startedAt: undefined,
    stoppable: true,
  };
  const WORKING = transcriptOf([
    put(
      tool("tool:survey", "Agent: Survey the parsers", {
        name: "Agent",
        status: "succeeded",
        spawns: {
          label: "survey",
          prompt: "survey them",
          model: undefined,
          state: "running",
          takesMessages: false,
        },
      }),
    ),
    put(assistant("survey-says", "reading lib/", { parent: "tool:survey" })),
    running(SURVEY),
  ]);

  /** A pane of a given width, as every ResizeObserver reports it. */
  function paneWidth(width: number) {
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: { width },
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    installResizeObserver();
  });

  it("fills the pane when opened, in a narrow pane and a wide one alike, and Back returns to the conversation", () => {
    for (const width of [600, WIDE_PANE_PX + 200]) {
      cleanup();
      paneWidth(width);
      draw(WORKING);
      fireEvent.click(toggle());
      fireEvent.click(
        screen.getByRole("button", { name: /Survey the parsers/ }),
      );
      const pane = screen.getByRole("region", { name: "Subagent: survey" });
      expect(pane).toHaveAttribute("data-place", "maximized");
      expect(pane).toContainElement(entry("survey-says"));
      expect(
        document.querySelector('[data-view="conversation"]'),
      ).not.toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "Back to the conversation" }),
      );
      expect(
        document.querySelector('[data-view="conversation"]'),
      ).toBeVisible();
    }
  });
});

describe("how long a background task has run", () => {
  it("is said as the CLI says it", () => {
    expect(elapsedText(0)).toBe("0s");
    expect(elapsedText(45_900)).toBe("45s");
    expect(elapsedText(192_000)).toBe("3m 12s");
    expect(elapsedText(3_900_000)).toBe("1h 5m");
    expect(elapsedText(-5_000)).toBe("0s");
  });

  it("ticks on each task whose start the CLI wrote, and says nothing for one it did not", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T10:03:12Z"));
    try {
      const started = Date.parse("2026-09-20T10:00:00Z");
      draw(withTasks({ ...SERVER, startedAt: started }, RESEARCH));
      fireEvent.click(toggle());
      const items = within(
        screen.getByRole("list", { name: "Background tasks" }),
      ).getAllByRole("listitem");
      const elapsed = (item: HTMLElement) =>
        item.querySelector(".conversation-background-elapsed");
      expect(elapsed(items[0]!)).toHaveTextContent("3m 12s");
      expect(elapsed(items[1]!)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(elapsed(items[0]!)).toHaveTextContent("3m 17s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stopping a background task", () => {
  const TEAMMATE: RunningTask = {
    id: "teammate:reviewer",
    kind: "teammate",
    title: "reviewer",
    call: undefined,
    startedAt: undefined,
    stoppable: { reason: "A teammate can't be stopped from here." },
  };

  function item(title: string): HTMLElement {
    const list = screen.getByRole("list", { name: "Background tasks" });
    return within(list)
      .getAllByRole("listitem")
      .find((each) => each.textContent?.includes(title))!;
  }

  it("has Stop at the right end of each task's line", () => {
    draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    for (const title of ["Start the dev server", "Research the parser"]) {
      const row = item(title).querySelector(".conversation-background-row")!;
      const stop = within(item(title)).getByRole("button", { name: "Stop" });
      expect(stop).toBeEnabled();
      expect(row.lastElementChild).toBe(stop);
    }
  });

  it("is greyed for a task that cannot be stopped, its tooltip saying why", () => {
    const { actions } = draw(withTasks(SERVER, TEAMMATE));
    fireEvent.click(toggle());
    const stop = within(item("reviewer")).getByRole("button", {
      name: "Stop",
    });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute(
      "title",
      "A teammate can't be stopped from here.",
    );
    fireEvent.click(stop);
    expect(within(item("reviewer")).queryByRole("group")).toBeNull();
    expect(actions.stopTask).not.toHaveBeenCalled();
  });

  it("asks once more, in words for its kind, and stops only when asked to", () => {
    const { actions } = draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    fireEvent.click(
      within(item("Start the dev server")).getByRole("button", {
        name: "Stop",
      }),
    );
    const asking = within(item("Start the dev server")).getByRole("group", {
      name: "Stop",
    });
    expect(asking).toHaveTextContent(
      "Stop this background shell? The command it's running will be terminated.",
    );
    expect(asking).toHaveClass("conversation-confirm");
    expect(actions.stopTask).not.toHaveBeenCalled();
    fireEvent.click(within(asking).getByRole("button", { name: "Cancel" }));
    expect(
      within(item("Start the dev server")).queryByRole("group"),
    ).toBeNull();

    fireEvent.click(
      within(item("Research the parser")).getByRole("button", { name: "Stop" }),
    );
    const again = within(item("Research the parser")).getByRole("group", {
      name: "Stop",
    });
    expect(again).toHaveTextContent(
      "Stop this subagent? Its work so far stays, and it won't resume on its own.",
    );
    fireEvent.click(within(again).getByRole("button", { name: "Stop" }));
    expect(actions.stopTask).toHaveBeenCalledWith("a1");
    // The task stays listed until the CLI says it ended.
    expect(item("Research the parser")).toBeDefined();
    expect(within(item("Research the parser")).queryByRole("group")).toBeNull();
  });

  it("leaves the list when the CLI's account of it says it ended", () => {
    const view = draw(withTasks(SERVER, RESEARCH));
    fireEvent.click(toggle());
    fireEvent.click(
      within(item("Research the parser")).getByRole("button", { name: "Stop" }),
    );
    fireEvent.click(
      within(item("Research the parser"))
        .getAllByRole("button", { name: "Stop" })
        .at(-1)!,
    );
    view.redraw(applyEvent(withTasks(SERVER, RESEARCH), running(SERVER)));
    const list = screen.getByRole("list", { name: "Background tasks" });
    expect(list).not.toHaveTextContent("Research the parser");
    expect(list).toHaveTextContent("Start the dev server");
  });

  it("says so when stopping failed", async () => {
    const refused = new Error("the Agent is not running");
    const actions = fakeActions({
      stopTask: vi.fn(() => Promise.reject(refused)),
    });
    draw(withTasks(SERVER), actions);
    fireEvent.click(toggle());
    fireEvent.click(
      within(item("Start the dev server")).getByRole("button", {
        name: "Stop",
      }),
    );
    await act(async () => {
      fireEvent.click(
        within(item("Start the dev server"))
          .getAllByRole("button", { name: "Stop" })
          .at(-1)!,
      );
    });
    expect(actions.reportFailure).toHaveBeenCalledWith(refused);
  });
});
