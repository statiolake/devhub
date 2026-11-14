import { describe, expect, it } from "vitest";
import { confirmChoices, nativePrompt, substituteMatch } from "./prompts";
import { applyRedraw, initialUiState } from "./redraw";

/** A prompt's command line, as Neovim 0.12 shows it (`cmdline_show`). */
function asking(prompt: string, typed = "", hl = 10): unknown[] {
  return [
    "cmdline_show",
    [[[0, typed, 0]], typed.length, "", prompt, 0, 1, hl],
  ];
}

function confirmMsg(text: string, id = 1): unknown[] {
  return [
    "msg_show",
    ["confirm", [[7, text, 10]], false, false, false, id, "typed_cmd"],
  ];
}

describe("confirm()'s answers, as Neovim renders them", () => {
  it("reads labels, accelerators and the default", () => {
    expect(confirmChoices("(D)elete, [C]ancel: ")).toEqual([
      { label: "Delete", accel: 0, key: "D", keys: "d", isDefault: false },
      { label: "Cancel", accel: 0, key: "C", keys: "c", isDefault: true },
    ]);
  });

  it("keeps an accelerator inside a label, and a label with spaces and dashes", () => {
    const choices = confirmChoices(
      "[O]pen Read-Only, (E)dit anyway, (R)ecover, (D)elete it, (Q)uit, (A)bort: ",
    );
    expect(choices?.map((c) => c.label)).toEqual([
      "Open Read-Only",
      "Edit anyway",
      "Recover",
      "Delete it",
      "Quit",
      "Abort",
    ]);
    expect(confirmChoices("Save (a)s, [N]o: ")?.[0]).toEqual({
      label: "Save as",
      accel: 5,
      key: "a",
      keys: "a",
      isDefault: false,
    });
  });

  it("keeps a comma inside a label with the label", () => {
    expect(
      confirmChoices("[y]es, please, (n)o: ")?.map((c) => c.label),
    ).toEqual(["yes, please", "no"]);
  });

  it("escapes a key nvim_input would read as a key name", () => {
    expect(confirmChoices("(<)back, [>]next: ")?.[0]?.keys).toBe("<lt>");
  });

  it("is not input()'s prompt", () => {
    expect(confirmChoices("Name: ")).toBeUndefined();
    expect(confirmChoices("Name (optional): ")).toBeUndefined();
    expect(confirmChoices("(D)elete")).toBeUndefined();
  });
});

describe("the prompt Neovim waits at", () => {
  it("is confirm()'s: its question's lines, then its answers", () => {
    const state = initialUiState();
    applyRedraw(state, [
      confirmMsg("Delete the file?\nIt is gone for good."),
      ["flush", []],
      asking("(D)elete, [C]ancel: "),
      ["flush", []],
    ]);
    const prompt = nativePrompt(state);
    expect(prompt).toMatchObject({
      kind: "confirm",
      title: "Delete the file?",
      body: ["It is gone for good."],
    });
    expect(
      prompt?.kind === "confirm" ? prompt.choices.map((c) => c.key) : [],
    ).toEqual(["D", "C"]);
    // Answered: gone with Neovim's command line.
    applyRedraw(state, [
      ["cmdline_hide", [1, false]],
      ["flush", []],
    ]);
    expect(nativePrompt(state)).toBeUndefined();
  });

  it("is E325's: the heading said before it is its title", () => {
    const state = initialUiState();
    applyRedraw(state, [
      [
        "msg_show",
        [
          "emsg",
          [[4, "E325: ATTENTION", 6]],
          false,
          true,
          false,
          1,
          "typed_cmd",
        ],
      ],
      confirmMsg(
        'Found a swap file by the name ".f.txt.swp"\n  modified: YES',
        2,
      ),
      asking("[O]pen Read-Only, (E)dit anyway, (Q)uit, (A)bort: "),
    ]);
    expect(nativePrompt(state)).toMatchObject({
      kind: "confirm",
      title: "E325: ATTENTION",
      body: ['Found a swap file by the name ".f.txt.swp"', "  modified: YES"],
    });
  });

  it("is confirm()'s with no question (`confirm('', '&OK')`)", () => {
    const state = initialUiState();
    applyRedraw(state, [
      ["msg_show", ["empty", [], false, false, false, -1, ""]],
      asking("[O]K: "),
    ]);
    expect(nativePrompt(state)).toMatchObject({
      kind: "confirm",
      title: "",
      body: [],
    });
  });

  it("is inputlist()'s: its numbered lines are answers, the number typed so far kept", () => {
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
          "typed_cmd",
        ],
      ],
      asking(
        "Type number and <Enter> or click with the mouse (q or empty cancels): ",
        "2",
        0,
      ),
    ]);
    expect(nativePrompt(state)).toEqual({
      kind: "list",
      title: "Pick one:",
      body: [],
      typed: "2",
      items: [
        {
          label: "alpha",
          accel: -1,
          key: "1",
          keys: "<C-u>1<CR>",
          isDefault: false,
        },
        {
          label: "beta",
          accel: -1,
          key: "2",
          keys: "<C-u>2<CR>",
          isDefault: false,
        },
      ],
    });
  });

  it("is :s///c's: the replacement and its five answers", () => {
    const state = initialUiState();
    applyRedraw(state, [
      asking(
        "replace with bar? (y)es/(n)o/(a)ll/(q)uit/(l)ast/scroll up(^E)/down(^Y)",
        "",
        18,
      ),
    ]);
    const prompt = nativePrompt(state);
    expect(prompt).toMatchObject({ kind: "substitute", replacement: "bar" });
    expect(
      prompt?.kind === "substitute" ? prompt.choices.map((c) => c.keys) : [],
    ).toEqual(["y", "n", "a", "q", "l"]);
  });

  it("is not input()'s, a typed command line's, or a nested one's", () => {
    const state = initialUiState();
    applyRedraw(state, [asking("Name: ", "x", 0)]);
    expect(nativePrompt(state)).toBeUndefined();
    applyRedraw(state, [
      ["cmdline_show", [[[0, "w", 0]], 1, ":", "", 0, 1, 0]],
    ]);
    expect(nativePrompt(state)).toBeUndefined();
    applyRedraw(state, [
      ["cmdline_show", [[[0, "", 0]], 0, "", "(Y)es, (N)o: ", 0, 2, 10]],
    ]);
    expect(nativePrompt(state)).toBeUndefined();
  });
});

describe(":s///c's match", () => {
  it("is the first cell Neovim draws with IncSearch in a window", () => {
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
      ["grid_resize", [2, 20, 3]],
      ["win_pos", [2, 1000, 0, 0, 20, 3]],
      [
        "grid_line",
        [2, 1, 0, [["x", 0], ["f", 7], ["o"], ["o"], [" ", 0], ["a"]], false],
      ],
    ]);
    expect(substituteMatch(state)).toEqual({ grid: 2, row: 1, col: 1, end: 4 });
  });
});
