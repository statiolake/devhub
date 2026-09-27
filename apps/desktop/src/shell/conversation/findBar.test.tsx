// @vitest-environment jsdom

/**
 * Cmd+F in a GUI Agent: the find bar, what it finds, how it steps through
 * the matches, and what it opens to show one.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, type ConversationEvent } from "../../model/conversation";
import { CURRENT_HIGHLIGHT, MATCH_HIGHLIGHT } from "./findHighlights";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { assistant, put, tool, transcriptOf, user } from "./transcriptFixtures";

/**
 * jsdom has no CSS Custom Highlight API: a registry that keeps what the page
 * sets, so a test can read which ranges are marked.
 */
const highlights = new Map<string, Set<Range>>();

/** jsdom lays nothing out: everything is drawn, in one small box on view. */
function drawnBox(): DOMRect {
  return DOMRect.fromRect({ x: 0, y: 0, width: 10, height: 10 });
}

beforeAll(() => {
  installResizeObserver();
  Element.prototype.getBoundingClientRect = drawnBox;
  Range.prototype.getBoundingClientRect = drawnBox;
  Element.prototype.checkVisibility = () => true;
  globalThis.Highlight = class extends Set<Range> {
    constructor(...ranges: Range[]) {
      super(ranges);
    }
  } as unknown as typeof Highlight;
  Object.defineProperty(CSS, "highlights", {
    value: highlights,
    configurable: true,
  });
});
beforeEach(() => {
  highlights.clear();
});
afterEach(cleanup);

function marked(name: string): string[] {
  return [...(highlights.get(name) ?? [])].map((range) => range.toString());
}

/** The current match, as the text around it: which entry it is in. */
function current(): Range {
  const [range] = highlights.get(CURRENT_HIGHLIGHT) ?? [];
  if (range === undefined) throw new Error("no match is current");
  return range;
}

function currentEntry(): string | undefined {
  return current().startContainer.parentElement?.closest<HTMLElement>(
    "[data-entry-id]",
  )?.dataset.entryId;
}

function composer(): HTMLElement {
  return screen.getByRole("textbox", { name: /message/i });
}

function field(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Find" });
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key, ...init });
}

function openFind(from: Element = composer()) {
  press(from, "f", { metaKey: true });
}

function search(query: string) {
  fireEvent.change(field(), { target: { value: query } });
}

function count(): string {
  return document.querySelector(".conversation-find-count")!.textContent!;
}

/** The count, once the search has run its slices. */
async function counted(text: string) {
  await waitFor(() => expect(count()).toBe(text));
}

const EVENTS: ConversationEvent[] = [
  put(user("u1", "Where is the parser configured?")),
  put(assistant("a1", "The **parser** reads `parser.toml` first.")),
  put(
    tool("t1", "Bash: cat config", {
      input: { command: "cat config" },
      output: [{ kind: "text", text: "[parser]\nstrict = true" }],
    }),
  ),
  put(assistant("a2", "Done.")),
];
const CONVERSATION = transcriptOf(EVENTS);

describe("the find bar", () => {
  it("opens on Cmd+F in the composer, with the keyboard in its field, saying what it searches", async () => {
    draw(CONVERSATION);
    composer().focus();
    openFind();
    expect(
      screen.getByRole("search", { name: "Find in the conversation" }),
    ).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(screen.getByRole("search")).toHaveTextContent(
      "Searching the conversation",
    );
  });

  it("opens on Cmd+F with the keyboard nowhere, as a click on the transcript's words leaves it, or on a word of it", async () => {
    draw(CONVERSATION);
    openFind(document.body);
    expect(field()).toHaveFocus();
    press(field(), "Escape");
    expect(screen.queryByRole("search")).toBeNull();
    openFind(entry("a1").querySelector("strong")!);
    expect(field()).toHaveFocus();
  });

  it("steps with F3 with the keyboard nowhere", async () => {
    draw(CONVERSATION);
    openFind(document.body);
    search("parser");
    await counted("4 of 4");
    document.body.focus();
    press(document.body, "F3", { shiftKey: true });
    await counted("3 of 4");
  });

  it("leaves Cmd+F alone while the pane is not the one shown, or when typed outside it", () => {
    const view = draw(CONVERSATION);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    openFind(elsewhere);
    expect(screen.queryByRole("search")).toBeNull();
    view.redraw(CONVERSATION, true);
    openFind(document.body);
    elsewhere.remove();
    expect(screen.queryByRole("search", { hidden: true })).toBeNull();
  });

  it("counts every match, a collapsed tool output's included, marks them, and makes the last current", async () => {
    draw(CONVERSATION);
    openFind();
    search("parser");
    await counted("4 of 4");
    // The question, the answer's word and its file name, and the output.
    await waitFor(() =>
      expect(marked(MATCH_HIGHLIGHT)).toEqual([
        "parser",
        "parser",
        "parser",
        "parser",
      ]),
    );
    await waitFor(() => expect(currentEntry()).toBe("t1"));
  });

  it("goes to the next and the previous match with Return and Shift+Return, around the ends", async () => {
    draw(CONVERSATION);
    openFind();
    search("parser");
    await counted("4 of 4");
    press(field(), "Enter");
    await counted("1 of 4");
    await waitFor(() => expect(currentEntry()).toBe("u1"));
    press(field(), "Enter", { shiftKey: true });
    press(field(), "Enter", { shiftKey: true });
    await counted("3 of 4");
    await waitFor(() => expect(currentEntry()).toBe("a1"));
    press(field(), "Enter");
    await counted("4 of 4");
  });

  it("steps with F3 and Shift+F3 from anywhere in the conversation while open, and with its buttons", async () => {
    draw(CONVERSATION);
    openFind();
    search("parser");
    await counted("4 of 4");
    composer().focus();
    press(composer(), "F3");
    await counted("1 of 4");
    press(entry("a2"), "F3", { shiftKey: true });
    await counted("4 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    await counted("3 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await counted("4 of 4");
  });

  it("leaves F3 alone while closed", () => {
    draw(CONVERSATION);
    const event = new KeyboardEvent("keydown", {
      key: "F3",
      bubbles: true,
      cancelable: true,
    });
    composer().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("opens a collapsed tool call when a match in its output becomes current", async () => {
    draw(CONVERSATION);
    const fold = entry("t1").querySelector<HTMLDetailsElement>(
      "details.conversation-tool",
    )!;
    expect(fold.open).toBe(false);
    openFind();
    search("strict");
    await counted("1 of 1");
    expect(fold.open).toBe(true);
  });

  it("opens a readable view cut by its Clip when a match in it becomes current", async () => {
    draw(
      transcriptOf([
        put(
          tool("e1", "Edit: src/app.ts", {
            name: "Edit",
            change: [
              {
                path: "src/app.ts",
                unifiedDiff:
                  "@@ -1,1 +1,1 @@\n-const mode = 1;\n+const mode = 2;",
              },
            ],
          }),
        ),
      ]),
    );
    const box = entry("e1").querySelector(".conversation-clip-box")!;
    expect(box).not.toHaveAttribute("data-open");
    openFind(document.body.querySelector(".conversation-surface")!);
    search("mode = 2");
    await counted("1 of 1");
    expect(box).toHaveAttribute("data-open");
  });

  it("unfolds a long message not from the person when the match is past its fold", async () => {
    const long = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join(
      "\n",
    );
    draw(transcriptOf([put(user("o1", long, "other"))]));
    const rest = entry("o1").querySelector(".conversation-other-rest")!;
    expect(rest).not.toBeVisible();
    openFind(document.body.querySelector(".conversation-surface")!);
    search("line 11");
    await counted("1 of 1");
    expect(rest).toBeVisible();
  });

  it("matches case only when asked to", async () => {
    draw(CONVERSATION);
    openFind();
    search("Parser");
    await counted("4 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await counted("No results");
    await waitFor(() => expect(marked(MATCH_HIGHLIGHT)).toEqual([]));
  });

  it("counts again as the conversation grows, and the current match stays put", async () => {
    const view = draw(CONVERSATION);
    openFind();
    search("parser");
    await counted("4 of 4");
    press(field(), "Enter", { shiftKey: true });
    await waitFor(() => expect(currentEntry()).toBe("a1"));
    act(() => {
      view.redraw(
        applyEvent(CONVERSATION, put(assistant("a3", "One more parser note."))),
      );
    });
    await counted("3 of 5");
    await waitFor(() => expect(currentEntry()).toBe("a1"));
  });

  it("closes on Esc, clears its marks, and gives the keyboard back without stopping a running turn", async () => {
    const running = applyEvent(CONVERSATION, {
      type: "state",
      state: { phase: "ready", turn: "running" },
    });
    const { actions } = draw(running);
    composer().focus();
    openFind();
    search("parser");
    press(field(), "Escape");
    expect(screen.queryByRole("search")).toBeNull();
    expect(composer()).toHaveFocus();
    await waitFor(() => expect(marked(MATCH_HIGHLIGHT)).toEqual([]));
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("starts a changed query at its last match again", async () => {
    draw(CONVERSATION);
    openFind();
    search("parser");
    await counted("4 of 4");
    press(field(), "Enter");
    await counted("1 of 4");
    search("parse");
    await counted("4 of 4");
    await waitFor(() => expect(currentEntry()).toBe("t1"));
  });

  it("puts the keyboard back in its field on Cmd+F while open, its words selected", async () => {
    draw(CONVERSATION);
    openFind();
    search("parser");
    composer().focus();
    openFind();
    expect(field()).toHaveFocus();
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("parser".length);
  });

  it("searches only the subagent that fills the pane, and says so", async () => {
    draw(
      transcriptOf([
        put(user("u1", "survey the parser")),
        put(
          tool("s1", "Task: Alpha", {
            name: "Task",
            status: "running",
            spawns: {
              label: "Alpha",
              prompt: "do Alpha",
              model: undefined,
              state: "running",
              takesMessages: false,
            },
          }),
        ),
        put(assistant("s1-a", "The parser is in src.", { parent: "s1" })),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximize Alpha" }));
    openFind(document.body.querySelector(".conversation-surface")!);
    expect(screen.getByRole("search")).toHaveTextContent(
      "Searching subagent Alpha",
    );
    search("parser");
    await counted("1 of 1");
    await waitFor(() => expect(currentEntry()).toBe("s1-a"));
  });
});
