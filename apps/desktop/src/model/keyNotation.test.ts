import { describe, expect, it } from "vitest";
import { formatKeys, keyCap } from "./keyNotation.js";

describe("keyCap", () => {
  it("writes Vim's notation as a Mac does, a modified letter a capital", () => {
    expect(keyCap("<C-v>")).toBe("⌃V");
    expect(keyCap("<c-s>")).toBe("⌃S");
    expect(keyCap("<M-v>")).toBe("⌥V");
    expect(keyCap("<A-v>")).toBe("⌥V");
    expect(keyCap("<S-v>")).toBe("⇧V");
    expect(keyCap("<D-s>")).toBe("⌘S");
    expect(keyCap("<CR>")).toBe("↩");
    expect(keyCap("<Esc>")).toBe("⎋");
    expect(keyCap("<Tab>")).toBe("⇥");
    expect(keyCap("<S-Tab>")).toBe("⇧⇥");
    expect(keyCap("<BS>")).toBe("⌫");
    expect(keyCap("<Up>")).toBe("↑");
    expect(keyCap("<Space>")).toBe("Space");
    expect(keyCap("<F5>")).toBe("F5");
  });

  it("puts the modifiers in the Mac's order, whatever order they came in", () => {
    expect(keyCap("<S-C-v>")).toBe("⌃⇧V");
    expect(keyCap("<M-C-x>")).toBe("⌃⌥X");
  });

  it("reads tmux's, DevHub's own and the caret notation the same way", () => {
    expect(keyCap("C-q")).toBe("⌃Q");
    expect(keyCap("M-x")).toBe("⌥X");
    expect(keyCap("Ctrl-X")).toBe("⌃X");
    expect(keyCap("Ctrl+x")).toBe("⌃X");
    expect(keyCap("^v")).toBe("⌃V");
    expect(keyCap("Return")).toBe("↩");
    expect(keyCap("Enter")).toBe("↩");
    expect(keyCap("Escape")).toBe("⎋");
    expect(keyCap("esc")).toBe("⎋");
    expect(keyCap("Tab")).toBe("⇥");
  });

  it("leaves this notation as it is", () => {
    for (const key of ["⌃V", "⌥V", "⇧V", "↩", "⎋", "⇥", "⌃⇧V"])
      expect(keyCap(key)).toBe(key);
  });

  it("keeps a letter's case when nothing modifies it: j and J are two keys", () => {
    expect(keyCap("j")).toBe("j");
    expect(keyCap("J")).toBe("J");
  });

  it("is no key for words and for Vim's names written bare", () => {
    expect(keyCap(":write")).toBeUndefined();
    expect(keyCap("cr")).toBeUndefined();
    expect(keyCap("a-b")).toBeUndefined();
    expect(keyCap("<Leader>")).toBeUndefined();
  });
});

describe("formatKeys", () => {
  it("writes each key of a hint, separators kept", () => {
    expect(formatKeys("<C-j> <C-k>")).toBe("⌃J ⌃K");
    expect(formatKeys("j/k")).toBe("j/k");
    expect(formatKeys("C-q =")).toBe("⌃Q =");
    expect(formatKeys("<C-w>v")).toBe("⌃W v");
    expect(formatKeys("gg")).toBe("gg");
    expect(formatKeys(":write")).toBe(":write");
  });
});
