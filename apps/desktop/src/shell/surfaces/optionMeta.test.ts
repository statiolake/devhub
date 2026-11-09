/**
 * Option as Meta on a Mac, end to end through the pure parts the control-mode
 * terminal (`terminal/control/controlKeys.ts`) and the Neovim editor
 * (`neovim/keys.ts`) are made of, with the KeyboardEvent shapes Chromium
 * reports on macOS.
 *
 * Under Xvfb there is no Option key, so the shapes are written out. They
 * follow Chromium's macOS rules: `key` is what the layout and Option made of
 * the key (Option+X `≈`), `code` is the physical key named by its US
 * position, a dead key's keydown is `key` "Dead" with keyCode 229, and the
 * composition it starts reaches the page whether or not the keydown was
 * cancelled. On a JIS keyboard `code` is still US-named: `BracketLeft` is
 * the key printed `@`, `Quote` the one printed `:`, `IntlYen` the ¥ key
 * (Option+¥ types `\`).
 */

import { describe, expect, it } from "vitest";
import { BaseKeys } from "./baseKeys";
import { MetaComposition, OptionKeys } from "./optionKey";
import {
  TerminalKeys,
  tmuxKey,
  type KeyLike,
} from "../terminal/control/controlKeys";
import { keyToNeovim } from "../neovim/keys";

type Shape = KeyLike & { readonly type: string };

const ev = (
  key: string,
  code: string,
  keyCode: number,
  mods: Partial<Shape> = {},
): Shape => ({
  type: "keydown",
  key,
  code,
  keyCode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  ...mods,
});

/** Recorded-style shapes: Option held, US (ABC) layout. */
const US = {
  leftOptionDown: ev("Alt", "AltLeft", 18, { altKey: true, location: 1 }),
  leftOptionUp: ev("Alt", "AltLeft", 18, { type: "keyup", location: 1 }),
  rightOptionDown: ev("Alt", "AltRight", 18, { altKey: true, location: 2 }),
  rightOptionUp: ev("Alt", "AltRight", 18, { type: "keyup", location: 2 }),
  optX: ev("≈", "KeyX", 88, { altKey: true }),
  optA: ev("å", "KeyA", 65, { altKey: true }),
  optB: ev("∫", "KeyB", 66, { altKey: true }),
  optShiftX: ev("˛", "KeyX", 88, { altKey: true, shiftKey: true }),
  optShift1: ev("⁄", "Digit1", 49, { altKey: true, shiftKey: true }),
  optE: ev("Dead", "KeyE", 229, { altKey: true }),
  optN: ev("Dead", "KeyN", 229, { altKey: true }),
  optP: ev("π", "KeyP", 229, { altKey: true, isComposing: true }),
  nDuringMark: ev("ñ", "KeyN", 229, { isComposing: true }),
  optUp: ev("ArrowUp", "ArrowUp", 38, { altKey: true }),
  optLeft: ev("ArrowLeft", "ArrowLeft", 37, { altKey: true }),
  optEnter: ev("Enter", "Enter", 13, { altKey: true }),
  optBackspace: ev("Backspace", "Backspace", 8, { altKey: true }),
  optSpace: ev(" ", "Space", 32, { altKey: true }),
  ctrlOptX: ev("≈", "KeyX", 88, { altKey: true, ctrlKey: true }),
  cmdLeft: ev("ArrowLeft", "ArrowLeft", 37, { metaKey: true }),
};

/** JIS keyboard, its layout's own characters. */
const JIS = {
  optYen: ev("\\", "IntlYen", 220, { altKey: true }),
  optShiftYen: ev("|", "IntlYen", 220, { altKey: true, shiftKey: true }),
  optAt: ev("€", "BracketLeft", 192, { altKey: true }),
  optColon: ev("…", "Quote", 186, { altKey: true }),
  optShift2: ev("™", "Digit2", 50, { altKey: true, shiftKey: true }),
  plainAt: ev("@", "BracketLeft", 192),
  plainShift2: ev('"', "Digit2", 50, { shiftKey: true }),
  layout: new Map([
    ["KeyA", "a"],
    ["KeyX", "x"],
    ["Digit2", "2"],
    ["BracketLeft", "@"],
    ["BracketRight", "["],
    ["Backslash", "]"],
    ["Quote", ":"],
    ["Semicolon", ";"],
    ["Equal", "^"],
    ["IntlYen", "¥"],
    ["IntlRo", "_"],
  ]),
};

/** The control-mode terminal under `setting`, fed key events in order. */
function terminal(setting: boolean | "left") {
  const keys = new TerminalKeys();
  const sent: string[] = [];
  return {
    keys,
    press(...events: Shape[]) {
      for (const e of events) {
        if (e.type === "keyup") keys.keyup(e, setting);
        else {
          const name = keys.keydown(e, setting);
          if (name !== undefined) sent.push(name);
        }
      }
      return sent;
    },
  };
}

describe("the left Option as Meta, US layout", () => {
  it("sends M- and the base key, not the Option character", () => {
    const t = terminal("left");
    expect(
      t.press(
        US.leftOptionDown,
        US.optX,
        US.optA,
        US.optB,
        US.optShiftX,
        US.optShift1,
        US.ctrlOptX,
        US.leftOptionUp,
      ),
    ).toEqual(["M-x", "M-a", "M-b", "M-X", "M-!", "C-M-x"]);
  });

  it("leaves the right Option typing symbols", () => {
    const t = terminal("left");
    expect(
      t.press(US.rightOptionDown, US.optX, US.optB, US.rightOptionUp),
    ).toEqual(["≈", "∫"]);
  });

  it("names special keys with M-, and the arrows as Ghostty binds them", () => {
    const t = terminal("left");
    expect(
      t.press(
        US.leftOptionDown,
        US.optUp,
        US.optEnter,
        US.optBackspace,
        US.optSpace,
        US.optLeft,
        US.leftOptionUp,
        US.cmdLeft,
      ),
    ).toEqual(["M-Up", "M-Enter", "M-BSpace", "M-Space", "M-b", "C-a"]);
  });

  it("sends a dead key as Meta and drops the composition it starts", () => {
    const t = terminal("left");
    expect(t.press(US.leftOptionDown, US.optE)).toEqual(["M-e"]);
    // macOS starts the mark anyway: nothing of it reaches the pane.
    expect(t.keys.drops("compositionstart")).toBe(true);
    expect(t.keys.drops("compositionupdate")).toBe(true);
    expect(t.keys.drops("input")).toBe(true);
    // Option+N then Option+P while the mark is up: both are Meta.
    t.press(US.optN, US.optP);
    expect(t.keys.drops("compositionend")).toBe(true);
    expect(t.press()).toEqual(["M-e", "M-n", "M-p"]);
  });

  it("sends the plain key that would have committed the mark by its key", () => {
    const t = terminal("left");
    t.press(US.leftOptionDown, US.optN, US.leftOptionUp);
    expect(t.keys.drops("compositionstart")).toBe(true);
    t.press(US.nDuringMark);
    expect(t.keys.drops("compositionend")).toBe(true);
    expect(t.press()).toEqual(["M-n", "n"]);
  });

  it("leaves a dead key on the right Option composing (Option+E, e is é)", () => {
    const t = terminal("left");
    expect(t.press(US.rightOptionDown, US.optE)).toEqual([]);
    expect(t.keys.drops("compositionstart")).toBe(false);
    expect(t.keys.drops("compositionend")).toBe(false);
  });

  it("leaves an IME composition alone, Option or not", () => {
    const t = terminal("left");
    const kana = ev("Process", "KeyK", 229, { isComposing: true });
    expect(t.press(kana)).toEqual([]);
    expect(t.keys.drops("compositionstart")).toBe(false);
    t.press(US.leftOptionDown);
    expect(
      t.press(ev("Process", "KeyX", 229, { altKey: true, isComposing: true })),
    ).toEqual([]);
    expect(t.keys.drops("compositionend")).toBe(false);
  });

  it("is never Meta under false, and both Options are under true", () => {
    expect(terminal(false).press(US.leftOptionDown, US.optX)).toEqual(["≈"]);
    expect(terminal(true).press(US.rightOptionDown, US.optX)).toEqual(["M-x"]);
  });
});

describe("the left Option as Meta on a JIS keyboard", () => {
  it("reads the base key from the layout, not from US positions", () => {
    const t = terminal("left");
    t.keys.layout.adopt(JIS.layout);
    expect(t.press(JIS.plainAt).concat()).toEqual(["@"]);
    expect(
      t.press(
        JIS.plainShift2,
        US.leftOptionDown,
        JIS.optAt,
        JIS.optColon,
        JIS.optShift2,
      ),
    ).toEqual(["@", '"', "M-@", "M-:", 'M-"']);
  });

  it("is Meta+\\ for the left Option+¥, and \\ for the right one", () => {
    const left = terminal("left");
    left.keys.layout.adopt(JIS.layout);
    expect(left.press(US.leftOptionDown, JIS.optYen, JIS.optShiftYen)).toEqual([
      "M-\\",
      "M-|",
    ]);
    const right = terminal("left");
    right.keys.layout.adopt(JIS.layout);
    expect(right.press(US.rightOptionDown, JIS.optYen)).toEqual(["\\"]);
  });

  it("says Shift apart for a key whose Shift the layout has not shown", () => {
    const t = terminal("left");
    t.keys.layout.adopt(JIS.layout);
    expect(t.press(US.leftOptionDown, JIS.optShift2)).toEqual(["M-S-2"]);
  });
});

describe("the Neovim editor's keys", () => {
  const jis = new BaseKeys();
  jis.adopt(JIS.layout);
  it("are <M-…> of the base key for a Meta Option", () => {
    expect(keyToNeovim(US.optX, true)).toBe("<M-x>");
    expect(keyToNeovim(US.optB, true)).toBe("<M-b>");
    expect(keyToNeovim(US.optShiftX, true)).toBe("<M-X>");
    expect(keyToNeovim(US.optE, true)).toBe("<M-e>");
    expect(keyToNeovim(US.optP, true)).toBe("<M-p>");
    expect(keyToNeovim(US.optSpace, true)).toBe("<M-Space>");
    expect(keyToNeovim(US.optUp, true)).toBe("<M-Up>");
    expect(keyToNeovim(US.optEnter, true)).toBe("<M-CR>");
    expect(keyToNeovim(US.ctrlOptX, true)).toBe("<C-M-x>");
    expect(keyToNeovim(JIS.optYen, true, jis)).toBe("<M-Bslash>");
    expect(keyToNeovim(JIS.optShiftYen, true, jis)).toBe("<M-Bar>");
    expect(keyToNeovim(JIS.optAt, true, jis)).toBe("<M-@>");
    expect(keyToNeovim(JIS.optShift2, true, jis)).toBe("<S-M-2>");
  });

  it("leave a non-Meta Option to the text it types", () => {
    expect(keyToNeovim(US.optX, false)).toBeUndefined();
    expect(keyToNeovim(US.optE, false)).toBeUndefined();
    expect(keyToNeovim(JIS.optYen, false, jis)).toBeUndefined();
  });
});

describe("what each physical key types without Option", () => {
  it("is US without a layout, the layout's with one, and what was typed first", () => {
    const keys = new BaseKeys();
    expect(keys.base("BracketLeft", false)).toBe("[");
    expect(keys.base("Digit2", true)).toBe("@");
    keys.adopt(JIS.layout);
    expect(keys.base("BracketLeft", false)).toBe("@");
    expect(keys.base("IntlYen", false)).toBe("\\");
    expect(keys.base("Digit2", true)).toBeUndefined();
    keys.learn(JIS.plainShift2);
    expect(keys.base("Digit2", true)).toBe('"');
    // AZERTY's A is where US has Q.
    keys.adopt(new Map([["KeyQ", "a"]]));
    expect(keys.base("KeyQ", true)).toBe("A");
  });

  it("learns nothing from Option chords, compositions or Caps Lock's case", () => {
    const keys = new BaseKeys();
    keys.learn(US.optX);
    keys.learn(ev("Process", "KeyK", 229, { isComposing: true }));
    keys.learn(ev("A", "KeyA", 65));
    expect(keys.base("KeyX", false)).toBe("x");
    expect(keys.base("KeyA", false)).toBe("a");
  });

  it("asks the Keyboard Map API, and keeps what it knew when that fails", async () => {
    const keys = new BaseKeys();
    await keys.loadLayout({ getLayoutMap: () => Promise.resolve(JIS.layout) });
    expect(keys.base("Quote", false)).toBe(":");
    await keys.loadLayout({
      getLayoutMap: () => Promise.reject(new Error("no")),
    });
    expect(keys.base("Quote", false)).toBe(":");
  });
});

describe("the left Option, told by a forwarded key", () => {
  it("counts an Alt keydown with no code at the left location", () => {
    const keys = new OptionKeys();
    keys.isMeta("left", {
      type: "keydown",
      code: "",
      key: "Alt",
      location: 1,
      altKey: true,
    });
    expect(
      keys.isMeta("left", { type: "keydown", code: "KeyX", altKey: true }),
    ).toBe(true);
  });

  it("drops only a composition a Meta key started", () => {
    const guard = new MetaComposition();
    guard.keydown(false);
    expect(guard.drops("compositionstart")).toBe(false);
    guard.keydown(true);
    expect(guard.drops("compositionstart")).toBe(true);
    guard.reset();
    expect(guard.drops("compositionupdate")).toBe(false);
  });
});

// `tmuxKey` alone, as before: no layout is US.
it("names a Meta chord by its US key when no layout is known", () => {
  expect(tmuxKey(US.optX, true)).toBe("M-x");
});
