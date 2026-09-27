// @vitest-environment jsdom

/**
 * Where a subagent's work is drawn: inline in its card, in the column beside
 * the conversation when the pane is wide, or filling the pane — and in only
 * one of them at a time.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
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
import { applyEvents, entryId, type ToolEntry } from "../../model/conversation";
import { WIDE_PANE_PX } from "./SubagentPanes";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import {
  assistant,
  opened,
  put,
  tool,
  toolRequest,
  transcriptOf,
} from "./transcriptFixtures";

type Spawns = NonNullable<ToolEntry["spawns"]>;

function subagent(
  id: string,
  label: string,
  state: Spawns["state"],
  takesMessages = false,
) {
  return put(
    tool(id, `Task: ${label}`, {
      name: "Task",
      status: state === "running" ? "running" : "succeeded",
      spawns: {
        label,
        prompt: `do ${label}`,
        model: undefined,
        state,
        takesMessages,
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

  it("draws each subagent inline, and offers a switcher to each running one", () => {
    draw(TWO);
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(
      screen.queryByRole("complementary", { name: "Subagents" }),
    ).toBeNull();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Conversation", "Alpha"]);
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

describe("the subagents listed, whatever the pane's width", () => {
  // Many that ended, in every way a subagent ends or stops being known, and
  // two still running.
  const MANY = transcriptOf([
    put(assistant("hello", "Starting many subagents")),
    subagent("d1", "Done1", "completed"),
    subagent("r1", "Run1", "running"),
    subagent("d2", "Done2", "completed"),
    subagent("f1", "Failed1", "failed"),
    subagent("u1", "Unknown1", "unknown"),
    subagent("i1", "Idle1", "idle"),
    subagent("r2", "Run2", "running"),
    subagent("d3", "Done3", "completed"),
  ]);

  /** The subagents the column lists: its panes, in order. */
  function inColumn(): readonly string[] {
    const column = screen.queryByRole("complementary", { name: "Subagents" });
    return column
      ? [...column.querySelectorAll("[data-view]")].map(
          (pane) => pane.getAttribute("data-view") ?? "",
        )
      : [];
  }

  /** The subagents the switcher lists: its tabs after the conversation's. */
  function inSwitcher(): readonly string[] {
    return screen
      .queryAllByRole("tab")
      .slice(1)
      .map((tab) => tab.textContent ?? "");
  }

  function drawnAt(width: number) {
    cleanup();
    paneWidth(width);
    if (width < WIDE_PANE_PX) installResizeObserver();
    draw(MANY);
  }

  it("are the running ones, in the narrow switcher as in the wide column", () => {
    drawnAt(WIDE_PANE_PX + 200);
    expect(inColumn()).toEqual(["r1", "r2"]);
    drawnAt(600);
    expect(inSwitcher()).toEqual(["Run1", "Run2"]);
  });

  it("keep an ended one the person opened until they leave it", () => {
    for (const width of [600, WIDE_PANE_PX + 200]) {
      drawnAt(width);
      fireEvent.click(screen.getByRole("button", { name: "Maximize Done2" }));
      expect(inSwitcher()).toEqual(["Run1", "Done2", "Run2"]);
      fireEvent.click(screen.getByRole("tab", { name: "Run1" }));
      expect(inSwitcher()).toEqual(["Run1", "Run2"]);
      fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
      if (width < WIDE_PANE_PX) {
        expect(inSwitcher()).toEqual(["Run1", "Run2"]);
      } else {
        expect(inColumn()).toEqual(["r1", "r2"]);
      }
      // Still reachable from its call in the transcript.
      expect(
        screen.getByRole("button", { name: "Maximize Done2" }),
      ).toBeTruthy();
    }
  });

  it("are the same whether the person put one beside or took one out", () => {
    drawnAt(WIDE_PANE_PX + 200);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show Done3 beside the conversation",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Put Run1 back in the conversation" }),
    );
    expect(inColumn()).toEqual(["r2", "d3"]);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Run2" }));
    expect(inSwitcher()).toEqual(["Run2", "Done3"]);
  });

  it("gain one the session launches after the pane was drawn", () => {
    for (const width of [600, WIDE_PANE_PX + 200]) {
      cleanup();
      paneWidth(width);
      if (width < WIDE_PANE_PX) installResizeObserver();
      const view = draw(MANY);
      view.redraw(applyEvents(MANY, [subagent("r3", "Run3", "running")]));
      if (width < WIDE_PANE_PX) {
        expect(inSwitcher()).toEqual(["Run1", "Run2", "Run3"]);
      } else {
        expect(inColumn()).toEqual(["r1", "r2", "r3"]);
      }
    }
  });

  it("are never cut off at the switcher's edge: its row wraps", () => {
    // jsdom applies no stylesheet, so the rule is read where it is written.
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const bar = /\n\.conversation-switcher \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(bar).toMatch(/flex-wrap:\s*wrap/);
    expect(bar).not.toMatch(/overflow/);
  });
});

describe("a message to a subagent that takes the person's messages", () => {
  const TALKING = transcriptOf([
    subagent("a", "Alpha", "running", true),
    put(assistant("a-answer", "alpha is working", { parent: "a" })),
  ]);

  /** Sends through the one message box drawn, which must be in `where`. */
  function sendFrom(where: HTMLElement) {
    const fields = screen.getAllByLabelText("Message to Alpha");
    expect(fields).toHaveLength(1);
    expect(where).toContainElement(fields[0]!);
    fireEvent.change(fields[0]!, { target: { value: "look in lib/ too" } });
    fireEvent.keyDown(fields[0]!, { key: "Enter" });
  }

  it("is in the column's pane when the subagent is beside the conversation", () => {
    paneWidth(WIDE_PANE_PX + 200);
    const actions = fakeActions();
    draw(TALKING, actions);
    sendFrom(screen.getByRole("region", { name: "Subagent: Alpha" }));
    expect(actions.instruct).toHaveBeenCalledWith(
      entryId("a"),
      "look in lib/ too",
    );
  });

  it("is in the pane the subagent fills when maximized", () => {
    paneWidth(600);
    installResizeObserver();
    const actions = fakeActions();
    draw(TALKING, actions);
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    sendFrom(screen.getByRole("region", { name: "Subagent: Alpha" }));
    expect(actions.instruct).toHaveBeenCalledWith(
      entryId("a"),
      "look in lib/ too",
    );
  });
});
