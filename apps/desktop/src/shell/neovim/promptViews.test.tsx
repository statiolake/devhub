// @vitest-environment jsdom

/**
 * Neovim's prompts drawn natively (`PromptViews.tsx`): the confirmation
 * sheet's answers and keys, a click that sends the answer's key and leaves
 * the closing to Neovim, `:s///c`'s bar held between two questions, and
 * the command line's box that never shows the raw prompt.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeovimEditor } from "./editor";
import {
  NativePrompts,
  promptIsNative,
  SUBSTITUTE_HOLD_MS,
} from "./PromptViews";
import { applyRedraw, initialUiState, type NeovimUiState } from "./redraw";

afterEach(cleanup);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** What the views ask of the editor. */
function stubEditor(): NeovimEditor {
  return {
    cellMetrics: () => ({ width: 8, height: 16 }),
    areaSize: () => ({ width: 640, height: 400 }),
    font: () => ({ family: "monospace", size: 13, lineHeight: 1 }),
    gridBoxes: () => [
      {
        grid: 2,
        row: 0,
        col: 0,
        width: 80,
        height: 24,
        z: 1,
        float: false,
        win: 1000,
      },
    ],
    cmdlinePlace: () => ({ left: 4, top: 370, width: 632, height: 26 }),
  } as unknown as NeovimEditor;
}

function asking(prompt: string, typed = ""): unknown[] {
  return [
    "cmdline_show",
    [[[0, typed, 0]], typed.length, "", prompt, 0, 1, 10],
  ];
}

function confirmState(question: string, answers: string): NeovimUiState {
  const state = initialUiState();
  applyRedraw(state, [
    [
      "msg_show",
      ["confirm", [[7, question, 10]], false, false, false, 1, "typed_cmd"],
    ],
    asking(answers),
  ]);
  return state;
}

describe("a confirm() drawn natively", () => {
  it("is a sheet: the question, one row per answer, the default selected", () => {
    const state = confirmState(
      "Delete the file?\nIt is gone for good.\n  (no undo)",
      "(D)elete, [C]ancel: ",
    );
    const { container } = render(
      <NativePrompts
        state={state}
        editor={stubEditor()}
        send={() => undefined}
      />,
    );
    const sheet = container.querySelector(".nvim-prompt");
    expect(sheet?.classList.contains("is-confirmation")).toBe(true);
    expect(sheet?.querySelector(".picker-title")?.textContent).toBe(
      "Delete the file?",
    );
    // The question's lines are kept, as Neovim laid them out.
    expect(sheet?.querySelector(".nvim-prompt-body")?.textContent).toBe(
      "It is gone for good.\n  (no undo)",
    );
    const rows = [...container.querySelectorAll(".nvim-prompt-choice")];
    expect(
      rows.map((r) => r.querySelector(".mac-list-title")?.textContent),
    ).toEqual(["Delete", "Cancel"]);
    // Each accelerator underlined, its key at the row's end.
    expect(rows.map((r) => r.querySelector("u")?.textContent)).toEqual([
      "D",
      "C",
    ]);
    expect(
      rows.map((r) => r.querySelector(".nvim-prompt-keys")?.textContent),
    ).toEqual(["D", "↩C"]);
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("draws three answers and E325's six alike", () => {
    for (const [answers, n] of [
      ["[Y]es, (N)o, (C)ancel: ", 3],
      [
        "[O]pen Read-Only, (E)dit anyway, (R)ecover, (D)elete it, (Q)uit, (A)bort: ",
        6,
      ],
    ] as const) {
      const { container, unmount } = render(
        <NativePrompts
          state={confirmState("Q?", answers)}
          editor={stubEditor()}
          send={() => undefined}
        />,
      );
      expect(container.querySelectorAll(".nvim-prompt-choice")).toHaveLength(n);
      unmount();
    }
  });

  it("sends a clicked answer's key and stays until Neovim leaves the prompt", () => {
    const state = confirmState("Delete?", "(D)elete, [C]ancel: ");
    const send = vi.fn();
    const editor = stubEditor();
    const { container, rerender } = render(
      <NativePrompts state={state} editor={editor} send={send} />,
    );
    const del = container.querySelectorAll(".nvim-prompt-choice")[0]!;
    // A click does not take the keyboard from the editor.
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    del.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(del);
    expect(send).toHaveBeenCalledWith("nvim_input", ["d"]);
    // Still there, shown as taken: Neovim has not answered.
    expect(container.querySelector(".nvim-prompt")).not.toBeNull();
    expect(del.getAttribute("aria-selected")).toBe("true");
    applyRedraw(state, [
      ["cmdline_hide", [1, false]],
      ["flush", []],
    ]);
    rerender(<NativePrompts state={state} editor={editor} send={send} />);
    expect(container.querySelector(".nvim-prompt")).toBeNull();
  });

  it("shows inputlist()'s items, the number typed and its row", () => {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "msg_show",
        [
          "confirm",
          [[0, "Pick one:\n1. alpha\n2. beta", 0]],
          false,
          false,
          false,
          1,
          "",
        ],
      ],
      asking(
        "Type number and <Enter> or click with the mouse (q or empty cancels): ",
        "2",
      ),
    ]);
    const send = vi.fn();
    const { container } = render(
      <NativePrompts state={state} editor={stubEditor()} send={send} />,
    );
    expect(container.querySelector(".nvim-prompt-field")?.textContent).toBe(
      "2",
    );
    const rows = [...container.querySelectorAll(".nvim-prompt-choice")];
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    fireEvent.click(rows[0]!);
    expect(send).toHaveBeenCalledWith("nvim_input", ["<C-u>1<CR>"]);
  });
});

describe(":s///c drawn natively", () => {
  const SUB =
    "replace with bar? (y)es/(n)o/(a)ll/(q)uit/(l)ast/scroll up(^E)/down(^Y)";

  function subState(): NeovimUiState {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "hl_attr_define",
        [
          7,
          {},
          {},
          [{ kind: "ui", ui_name: "IncSearch", hi_name: "IncSearch" }],
        ],
      ],
      ["grid_resize", [2, 80, 24]],
      ["win_pos", [2, 1000, 0, 0, 80, 24]],
      ["grid_line", [2, 3, 4, [["f", 7], ["o"], ["o"]], false]],
      asking(SUB),
      ["flush", []],
    ]);
    return state;
  }

  it("is a bar under the match with Yes, No, All, Quit and Last", () => {
    const send = vi.fn();
    const { container } = render(
      <NativePrompts state={subState()} editor={stubEditor()} send={send} />,
    );
    const bar = container.querySelector<HTMLElement>(".nvim-prompt-bar");
    expect(bar?.style.top).toBe(`${String(4 * 16 + 2)}px`);
    const buttons = [...container.querySelectorAll(".nvim-prompt-bar-button")];
    expect(buttons.map((b) => b.getAttribute("data-key"))).toEqual([
      "y",
      "n",
      "a",
      "q",
      "l",
    ]);
    expect(bar?.textContent).toContain("bar");
    fireEvent.click(buttons[2]!);
    expect(send).toHaveBeenCalledWith("nvim_input", ["a"]);
  });

  it("is held through the flush between two questions, and goes after the last", () => {
    const state = subState();
    const editor = stubEditor();
    const { container, rerender } = render(
      <NativePrompts state={state} editor={editor} send={() => undefined} />,
    );
    // Answered: Neovim hides its command line and flushes before the next.
    applyRedraw(state, [
      ["cmdline_hide", [1, false]],
      ["flush", []],
    ]);
    rerender(
      <NativePrompts state={state} editor={editor} send={() => undefined} />,
    );
    expect(container.querySelector(".nvim-prompt-bar")).not.toBeNull();
    applyRedraw(state, [asking(SUB), ["flush", []]]);
    rerender(
      <NativePrompts state={state} editor={editor} send={() => undefined} />,
    );
    expect(container.querySelector(".nvim-prompt-bar")).not.toBeNull();
    // The last one: nothing comes after it.
    applyRedraw(state, [
      ["cmdline_hide", [1, false]],
      ["flush", []],
    ]);
    rerender(
      <NativePrompts state={state} editor={editor} send={() => undefined} />,
    );
    act(() => {
      vi.advanceTimersByTime(SUBSTITUTE_HOLD_MS + 5);
    });
    expect(container.querySelector(".nvim-prompt-bar")).toBeNull();
  });
});

describe("the command line's box under a native prompt", () => {
  it("leaves the prompt, and its question coming first, to the native view", () => {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "msg_show",
        ["confirm", [[7, "Delete?", 10]], false, false, false, 1, ""],
      ],
      ["flush", []],
    ]);
    // The question has come, its answers not yet: nothing raw is drawn.
    expect(promptIsNative(state)).toBe(true);
    applyRedraw(state, [asking("(D)elete, [C]ancel: "), ["flush", []]]);
    expect(promptIsNative(state)).toBe(true);
    applyRedraw(state, [
      ["cmdline_hide", [1, false]],
      ["flush", []],
    ]);
    expect(promptIsNative(state)).toBe(false);
    // input()'s prompt is the box's own.
    applyRedraw(state, [asking("Name: ", "x")]);
    expect(promptIsNative(state)).toBe(false);
  });
});
