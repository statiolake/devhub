import { describe, expect, it } from "vitest";
import { escapeInputText, keyToNeovim, type KeyInput } from "./keys";

const key = (
  k: string,
  code: string,
  mods: Partial<KeyInput> = {},
): KeyInput => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("a key as Neovim's key notation", () => {
  const cases: [string, KeyInput, boolean, string | undefined][] = [
    ["plain text arrives as text", key("a", "KeyA"), false, undefined],
    ["so does Shift", key("A", "KeyA", { shiftKey: true }), false, undefined],
    ["Escape", key("Escape", "Escape"), false, "<Esc>"],
    ["Enter", key("Enter", "Enter"), false, "<CR>"],
    ["Shift+Tab", key("Tab", "Tab", { shiftKey: true }), false, "<S-Tab>"],
    ["Ctrl+Up", key("ArrowUp", "ArrowUp", { ctrlKey: true }), false, "<C-Up>"],
    ["Ctrl+a", key("a", "KeyA", { ctrlKey: true }), false, "<C-a>"],
    [
      "Ctrl+Shift+a",
      key("A", "KeyA", { ctrlKey: true, shiftKey: true }),
      false,
      "<C-S-a>",
    ],
    ["Ctrl+[", key("[", "BracketLeft", { ctrlKey: true }), false, "<C-[>"],
    [
      "Ctrl+<",
      key("<", "Comma", { ctrlKey: true, shiftKey: true }),
      false,
      "<C-lt>",
    ],
    ["Ctrl+Space", key(" ", "Space", { ctrlKey: true }), false, "<C-Space>"],
    [
      "Shift+F10, the keyboard's right-click",
      key("F10", "F10", { shiftKey: true }),
      false,
      "<S-F10>",
    ],
    [
      "the menu key is Shift+F10",
      key("ContextMenu", "ContextMenu"),
      false,
      "<S-F10>",
    ],
    [
      "Option as Meta takes the physical key",
      key("≈", "KeyX", { altKey: true }),
      true,
      "<M-x>",
    ],
    [
      "Option as Meta with Shift",
      key("˛", "KeyX", { altKey: true, shiftKey: true }),
      true,
      "<M-X>",
    ],
    [
      "Option not Meta types what the layout says",
      key("≈", "KeyX", { altKey: true }),
      false,
      undefined,
    ],
    ["Cmd+s", key("s", "KeyS", { metaKey: true }), false, "<D-s>"],
    [
      "Cmd+Shift+z, reported lowercase",
      key("z", "KeyZ", { metaKey: true, shiftKey: true }),
      false,
      "<D-Z>",
    ],
    ["Cmd+\\", key("\\", "Backslash", { metaKey: true }), false, "<D-Bslash>"],
    [
      "Cmd+|",
      key("|", "Backslash", { metaKey: true, shiftKey: true }),
      false,
      "<D-Bar>",
    ],
    [
      "a lone modifier",
      key("Shift", "ShiftLeft", { shiftKey: true }),
      false,
      undefined,
    ],
    ["a dead key", key("Dead", "KeyE", { altKey: true }), false, undefined],
    [
      "anything while composing",
      key("Enter", "Enter", { isComposing: true }),
      false,
      undefined,
    ],
    ["the IME's Process key", key("Process", "KeyA"), false, undefined],
    ["F5", key("F5", "F5"), false, "<F5>"],
    [
      "Cmd+Shift+Left",
      key("ArrowLeft", "ArrowLeft", { metaKey: true, shiftKey: true }),
      false,
      "<S-D-Left>",
    ],
  ];
  for (const [name, input, meta, expected] of cases) {
    it(name, () => {
      expect(keyToNeovim(input, meta)).toBe(expected);
    });
  }

  it("escapes < in text, and nothing else", () => {
    expect(escapeInputText("a<b>c|\\")).toBe("a<lt>b>c|\\");
  });
});
