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
  // jsdom has no pointer capture; a sash only asks for it.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  // Nor pointer events: one is a mouse event with a pointer's id.
  globalThis.PointerEvent ??= class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  } as unknown as typeof PointerEvent;
});
afterEach(cleanup);

describe("a narrow pane", () => {
  beforeEach(() => {
    paneWidth(600);
    installResizeObserver();
  });

  it("draws each subagent inline, with no bar of subagents above the composer", () => {
    draw(TWO);
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(
      screen.queryByRole("complementary", { name: "Subagents" }),
    ).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("fills the pane with a subagent from its card, draws its work only there, and goes back", () => {
    draw(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Alpha" }));
    const pane = screen.getByRole("region", { name: "Subagent: Alpha" });
    expect(pane).toContainElement(entry("a-answer"));
    expect(drawn("a-answer")).toBe(1);
    expect(entry("a")).toHaveTextContent("Shown filling the pane.");
    expect(
      document.querySelector('[data-view="conversation"]'),
    ).not.toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to the conversation" }),
    );
    expect(
      screen.queryByRole("region", { name: "Subagent: Alpha" }),
    ).toBeNull();
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(document.querySelector('[data-view="conversation"]')).toBeVisible();
  });

  it("maximizes one that has ended from its card too", () => {
    draw(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Beta" }));
    expect(
      screen.getByRole("region", { name: "Subagent: Beta" }),
    ).toContainElement(entry("b-answer"));
  });

  it("goes back to the conversation to show a request waiting there", () => {
    draw(
      transcriptOf([
        subagent("a", "Alpha", "running"),
        put(tool("bash", "Bash: npm test", { status: "running" })),
        opened(toolRequest("r1", "bash")),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximize Alpha" }));
    fireEvent.click(
      screen.getByRole("button", { name: /1 request is waiting/ }),
    );
    expect(document.querySelector('[data-view="conversation"]')).toBeVisible();
    expect(
      screen.getByRole("group", { name: "The Agent is waiting for an answer" }),
    ).toHaveFocus();
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
  });

  it("takes a subagent out of the column and puts it back, as the person chooses", () => {
    draw(TWO);
    const alphaBeside = screen.getByRole("button", {
      name: "Show Alpha beside the conversation",
    });
    expect(alphaBeside).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(alphaBeside);
    expect(alphaBeside).toHaveAttribute("aria-pressed", "false");
    expect(entry("a")).toContainElement(entry("a-answer"));
    expect(
      screen.queryByRole("complementary", { name: "Subagents" }),
    ).toBeNull();

    fireEvent.click(alphaBeside);
    expect(
      screen.getByRole("complementary", { name: "Subagents" }),
    ).toContainElement(entry("a-answer"));
  });

  it("offers no Beside toggle on a subagent that has ended, only Maximize", () => {
    draw(TWO);
    expect(
      screen.queryByRole("button", {
        name: "Show Beta beside the conversation",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Maximize Beta" })).toBeTruthy();
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
    fireEvent.click(
      screen.getByRole("button", { name: "Back to the conversation" }),
    );
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

describe("the column, laid out as VS Code lays out its views", () => {
  const THREE = transcriptOf([
    subagent("a", "Alpha", "running", true),
    put(assistant("a-answer", "alpha is working", { parent: "a" })),
    subagent("b", "Beta", "running"),
    subagent("c", "Gamma", "running"),
  ]);

  beforeEach(() => paneWidth(WIDE_PANE_PX + 200));

  function pane(label: string): HTMLElement {
    return screen.getByRole("region", { name: `Subagent: ${label}` });
  }

  /** Every element's box, as the browser would lay it out, by selector. */
  function boxes(sizes: Record<string, { width: number; height: number }>) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const size = Object.entries(sizes).find(([selector]) =>
          this.matches(selector),
        )?.[1] ?? { width: 0, height: 0 };
        return {
          ...size,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        } as DOMRect;
      },
    );
  }

  afterEach(() => vi.restoreAllMocks());

  it("folds a pane to its header in its place, and unfolds it from the header", () => {
    draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: "Fold Alpha" }));
    expect(pane("Alpha")).toHaveAttribute("data-folded", "true");
    // Still in the column, in its place; its work and message box are not.
    expect(
      [
        ...document.querySelectorAll(
          ".conversation-subagent-column [data-view]",
        ),
      ].map((each) => each.getAttribute("data-view")),
    ).toEqual(["a", "b", "c"]);
    expect(entry("a-answer")).not.toBeVisible();
    expect(screen.queryByLabelText("Message to Alpha")).toBeNull();
    expect(entry("a")).toHaveTextContent(
      "Shown in the column beside the conversation.",
    );
    // The header itself unfolds it.
    fireEvent.click(pane("Alpha").querySelector("header")!);
    expect(pane("Alpha")).not.toHaveAttribute("data-folded");
    expect(entry("a-answer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Fold Alpha" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("draws the fold on the header's left and Maximize on its right, as icons with names", () => {
    draw(THREE);
    const header = pane("Beta").querySelector("header")!;
    const buttons = [...header.querySelectorAll("button")];
    expect(buttons.map((each) => each.getAttribute("aria-label"))).toEqual([
      "Fold Beta",
      "Maximize Beta",
    ]);
    expect(header.firstElementChild).toBe(buttons[0]);
    for (const button of buttons) {
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).toHaveAttribute("title");
    }
  });

  it("draws the line between two panes over the lower one's header, open or folded, and none over the first", () => {
    // jsdom lays nothing out, so the lines are read from the rules that match
    // each header in the stylesheet as written.
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(
      "src/shell/conversation/conversation.css",
      "utf8",
    );
    document.head.append(sheet);
    const rules = [...sheet.sheet!.cssRules].filter(
      (rule): rule is CSSStyleRule =>
        // The pane's own rules: the rest are about other things, and jsdom
        // cannot match every selector in them.
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes("conversation-subagent-pane"),
    );
    sheet.remove();
    /** The border sides a rule matching `element` draws. */
    function lines(element: Element): readonly string[] {
      return rules
        .filter((rule) => element.matches(rule.selectorText))
        .flatMap((rule) =>
          ["border-top", "border-bottom", "border"].filter(
            (side) => rule.style.getPropertyValue(side) !== "",
          ),
        );
    }

    draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: "Fold Beta" }));
    expect(
      ["Alpha", "Beta", "Gamma"].map((label) =>
        lines(pane(label).querySelector("header")!),
      ),
    ).toEqual([[], ["border-top"], ["border-top"]]);
    // Nor does a pane draw one of its own under the sash between it and the
    // next.
    expect(lines(pane("Alpha"))).toEqual([]);
  });

  it("puts ← back to the conversation on the left of the pane it fills", () => {
    draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Beta" }));
    const header = pane("Beta").querySelector("header")!;
    const back = screen.getByRole("button", {
      name: "Back to the conversation",
    });
    expect(header.firstElementChild).toBe(back);
    expect(back.textContent).toBe("");
    fireEvent.click(back);
    expect(document.querySelector('[data-view="conversation"]')).toBeVisible();
  });

  it("widens the column from its edge, by the keys too, within its bounds, and puts it back on a double-click", () => {
    boxes({
      ".conversation-views": { width: 1200, height: 800 },
      ".conversation-subagent-column": { width: 400, height: 800 },
    });
    draw(THREE);
    const column = screen.getByRole("complementary", { name: "Subagents" });
    const edge = screen.getByRole("separator", {
      name: "Resize the subagent column",
    });
    fireEvent.pointerDown(edge, { clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 700, pointerId: 1 });
    expect(column.style.getPropertyValue("--subagent-column-width")).toBe(
      "500px",
    );
    // No further than leaves the conversation its least.
    fireEvent.pointerMove(edge, { clientX: 100, pointerId: 1 });
    expect(column.style.getPropertyValue("--subagent-column-width")).toBe(
      "800px",
    );
    fireEvent.pointerUp(edge, { pointerId: 1 });
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(column.style.getPropertyValue("--subagent-column-width")).toBe(
      "416px",
    );
    fireEvent.doubleClick(edge);
    expect(column.style.getPropertyValue("--subagent-column-width")).toBe("");
  });

  it("shares the height of two open panes by the sash between them, past a folded one, and evens them on a double-click", () => {
    boxes({
      '[data-view="a"]': { width: 400, height: 300 },
      '[data-view="b"]': { width: 400, height: 200 },
      '[data-view="c"]': { width: 400, height: 300 },
    });
    draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: "Fold Beta" }));
    // Alpha and Gamma are next to each other now: one sash, and none by Beta.
    const sashes = screen.getAllByRole("separator", {
      name: /^Resize .* and /,
    });
    expect(sashes.map((each) => each.getAttribute("aria-label"))).toEqual([
      "Resize Alpha and Gamma",
    ]);
    const sash = sashes[0]!;
    fireEvent.pointerDown(sash, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(sash, { clientY: 350, pointerId: 1 });
    fireEvent.pointerUp(sash, { pointerId: 1 });
    expect(pane("Alpha").style.flexGrow).toBe("350");
    expect(pane("Gamma").style.flexGrow).toBe("250");
    // Folded, Beta takes no share.
    expect(pane("Beta").style.flexGrow).toBe("");
    fireEvent.keyDown(sash, { key: "ArrowUp" });
    expect(pane("Alpha").style.flexGrow).toBe("284");
    fireEvent.doubleClick(sash);
    expect(pane("Alpha").style.flexGrow).toBe("1");
    expect(pane("Gamma").style.flexGrow).toBe("1");
  });

  it("lets a pane go with its size and fold when it leaves, the rest taking its room", () => {
    boxes({
      '[data-view="a"]': { width: 400, height: 300 },
      '[data-view="b"]': { width: 400, height: 300 },
      '[data-view="c"]': { width: 400, height: 200 },
    });
    const view = draw(THREE);
    const sash = screen.getByRole("separator", {
      name: "Resize Alpha and Beta",
    });
    fireEvent.pointerDown(sash, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(sash, { clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(sash, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Fold Gamma" }));
    expect(pane("Beta").style.flexGrow).toBe("350");

    // Beta ends: it leaves, and Alpha and Gamma keep what they had.
    view.redraw(applyEvents(THREE, [subagent("b", "Beta", "completed")]));
    expect(screen.queryByRole("region", { name: "Subagent: Beta" })).toBeNull();
    expect(pane("Alpha").style.flexGrow).toBe("250");
    expect(pane("Gamma")).toHaveAttribute("data-folded", "true");

    // Gamma taken out and put back comes back open, at an ordinary size.
    const gammaBeside = screen.getByRole("button", {
      name: "Show Gamma beside the conversation",
    });
    fireEvent.click(gammaBeside);
    fireEvent.click(gammaBeside);
    expect(pane("Gamma")).not.toHaveAttribute("data-folded");
    expect(pane("Gamma").style.flexGrow).toBe("250");
  });
});

describe("the subagents the column lists", () => {
  // Many that ended, in every way a subagent ends or stops being known, one
  // idle (waiting, and able to run again), and two still running.
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

  beforeEach(() => paneWidth(WIDE_PANE_PX + 200));

  /** The subagents the column lists: its panes, in order. */
  function inColumn(): readonly string[] {
    const column = screen.queryByRole("complementary", { name: "Subagents" });
    return column
      ? [...column.querySelectorAll("[data-view]")].map(
          (pane) => pane.getAttribute("data-view") ?? "",
        )
      : [];
  }

  function back() {
    fireEvent.click(
      screen.getByRole("button", { name: "Back to the conversation" }),
    );
  }

  it("are the ones that have not ended", () => {
    draw(MANY);
    expect(inColumn()).toEqual(["r1", "i1", "r2"]);
  });

  it("let one go when it ends, even one the person put back beside", () => {
    const view = draw(MANY);
    const beside = screen.getByRole("button", {
      name: "Show Run1 beside the conversation",
    });
    fireEvent.click(beside);
    fireEvent.click(beside);
    view.redraw(
      applyEvents(MANY, [
        subagent("r1", "Run1", "completed"),
        subagent("i1", "Idle1", "running"),
      ]),
    );
    expect(inColumn()).toEqual(["i1", "r2"]);
    // Still reachable from its call in the transcript.
    expect(screen.getByRole("button", { name: "Maximize Run1" })).toBeTruthy();
  });

  it("keep one that ends while it fills the pane there until the person leaves it", () => {
    const view = draw(MANY);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Run1" }));
    view.redraw(applyEvents(MANY, [subagent("r1", "Run1", "completed")]));
    expect(screen.getByRole("region", { name: "Subagent: Run1" })).toBeTruthy();
    back();
    expect(inColumn()).toEqual(["i1", "r2"]);
  });

  it("do not gain an ended one the person opened", () => {
    draw(MANY);
    fireEvent.click(screen.getByRole("button", { name: "Maximize Done2" }));
    expect(
      screen.getByRole("region", { name: "Subagent: Done2" }),
    ).toBeTruthy();
    back();
    expect(inColumn()).toEqual(["r1", "i1", "r2"]);
    // Still reachable from its call in the transcript.
    expect(screen.getByRole("button", { name: "Maximize Done2" })).toBeTruthy();
  });

  it("gain one the session launches after the pane was drawn", () => {
    const view = draw(MANY);
    view.redraw(applyEvents(MANY, [subagent("r3", "Run3", "running")]));
    expect(inColumn()).toEqual(["r1", "i1", "r2", "r3"]);
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
    fireEvent.keyDown(fields[0]!, { key: "Enter", metaKey: true });
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
    fireEvent.click(screen.getByRole("button", { name: "Maximize Alpha" }));
    sendFrom(screen.getByRole("region", { name: "Subagent: Alpha" }));
    expect(actions.instruct).toHaveBeenCalledWith(
      entryId("a"),
      "look in lib/ too",
    );
  });
});
