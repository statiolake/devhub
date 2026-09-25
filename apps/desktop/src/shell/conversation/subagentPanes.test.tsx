// @vitest-environment jsdom

/**
 * Where a subagent's work is drawn: inline in its card, in the column beside
 * the conversation when the pane is wide, or filling the pane — and in only
 * one of them at a time.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ToolEntry } from "../../model/conversation";
import { WIDE_PANE_PX } from "./SubagentPanes";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import {
  assistant,
  opened,
  put,
  tool,
  toolRequest,
  transcriptOf,
} from "./transcriptFixtures";

type Spawns = NonNullable<ToolEntry["spawns"]>;

function subagent(id: string, label: string, state: Spawns["state"]) {
  return put(
    tool(id, `Task: ${label}`, {
      name: "Task",
      status: state === "running" ? "running" : "succeeded",
      spawns: {
        label,
        prompt: `do ${label}`,
        model: undefined,
        state,
      },
    }),
  );
}

const TWO = transcriptOf([
  put(assistant("hello", "Starting two subagents")),
  subagent("a", "Alpha", "running"),
  put(assistant("a-answer", "alpha is working", { parent: "a" })),
  subagent("b", "Beta", "completed"),
  put(assistant("b-answer", "beta finished", { parent: "b" })),
]);

/** Every place an entry is drawn: there must be exactly one. */
function drawn(id: string): number {
  return document.querySelectorAll(`[data-entry-id="${id}"]`).length;
}

/**
 * A pane of a given width: every ResizeObserver reports it as soon as it
 * observes, as the browser does for a box it has laid out.
 */
function paneWidth(width: number) {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("a narrow pane", () => {
  beforeEach(() => {
    paneWidth(600);
    installResizeObserver();
  });

  it("draws each subagent inline, and offers a switcher to each one", () => {
    draw(TWO);
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(
      screen.queryByRole("complementary", { name: "Subagents" }),
    ).toBeNull();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Conversation", "Alpha", "Beta"]);
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("fills the pane with a subagent from the switcher, and draws its work only there", () => {
    draw(TWO);
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    const pane = screen.getByRole("region", { name: "Subagent: Alpha" });
    expect(pane).toContainElement(entry("a-answer"));
    expect(drawn("a-answer")).toBe(1);
    expect(entry("a")).toHaveTextContent("Shown filling the pane.");
    expect(
      document.querySelector('[data-view="conversation"]'),
    ).not.toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to the conversation" }),
    );
    expect(
      screen.queryByRole("region", { name: "Subagent: Alpha" }),
    ).toBeNull();
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(document.querySelector('[data-view="conversation"]')).toBeVisible();
  });

  it("maximizes a subagent from its card", () => {
    draw(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Beta" }));
    expect(
      screen.getByRole("region", { name: "Subagent: Beta" }),
    ).toContainElement(entry("b-answer"));
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("moves along the switcher with the arrow keys, the keyboard going with it", () => {
    draw(TWO);
    const first = screen.getByRole("tab", { name: "Conversation" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    expect(
      screen.getByRole("region", { name: "Subagent: Alpha" }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Alpha" }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: /Subagent:/ })).toBeNull();
  });

  it("goes back to the conversation to show a request waiting there", () => {
    draw(
      transcriptOf([
        subagent("a", "Alpha", "running"),
        put(tool("bash", "Bash: npm test", { status: "running" })),
        opened(toolRequest("r1", "bash")),
      ]),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    fireEvent.click(
      screen.getByRole("button", { name: /1 request is waiting/ }),
    );
    expect(document.querySelector('[data-view="conversation"]')).toBeVisible();
    expect(
      screen.getByRole("group", { name: "The Agent is waiting for an answer" }),
    ).toHaveFocus();
  });

  it("offers no switcher while there is no subagent", () => {
    draw(transcriptOf([put(assistant("hello", "no subagents here"))]));
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("a wide pane", () => {
  beforeEach(() => paneWidth(WIDE_PANE_PX + 200));

  it("draws a running subagent in the column beside, and a finished one inline", () => {
    draw(TWO);
    const column = screen.getByRole("complementary", { name: "Subagents" });
    expect(column).toContainElement(entry("a-answer"));
    expect(drawn("a-answer")).toBe(1);
    expect(entry("a")).toHaveTextContent(
      "Shown in the column beside the conversation.",
    );
    expect(entry("b")).toContainElement(entry("b-answer"));
    // Wide, and nothing maximized: no switcher.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("puts a subagent beside and takes it back, as the person chooses", () => {
    draw(TWO);
    fireEvent.click(
      screen.getByRole("button", { name: "Show Beta beside the conversation" }),
    );
    const column = screen.getByRole("complementary", { name: "Subagents" });
    expect(column).toContainElement(entry("b-answer"));
    // Stacked in transcript order.
    expect(
      [...column.querySelectorAll("[data-view]")].map((pane) =>
        pane.getAttribute("data-view"),
      ),
    ).toEqual(["a", "b"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Put Alpha back in the conversation",
      }),
    );
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(column).not.toContainElement(entry("a-answer"));
  });

  it("fills the pane with one subagent, setting the column aside, and switches back", () => {
    draw(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Alpha" }));
    expect(
      screen.queryByRole("complementary", { name: "Subagents" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Subagent: Alpha" }),
    ).toContainElement(entry("a-answer"));
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(
      screen.getByRole("complementary", { name: "Subagents" }),
    ).toContainElement(entry("a-answer"));
  });

  it("finds a request card waiting in the column", () => {
    draw(
      transcriptOf([
        subagent("a", "Alpha", "running"),
        put(
          tool("inner", "Bash: rm -rf build", {
            parent: "a",
            status: "running",
          }),
        ),
        opened(toolRequest("r1", "inner")),
      ]),
    );
    const column = screen.getByRole("complementary", { name: "Subagents" });
    const card = screen.getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    expect(column).toContainElement(card);
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: /1 request is waiting/ }),
      );
    });
    expect(card).toHaveFocus();
  });
});
