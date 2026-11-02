// @vitest-environment jsdom

/**
 * Option as Meta against the real xterm.js, fed the events Chromium on a Mac
 * delivers.
 *
 * `xtermSession.test.ts` mocks the emulator, so it can say which switch was
 * set but not what reached the pane. The bug this pins was in the gap between
 * the two: with the left Option as Meta, Option+N then Option+P sent `ESC n`,
 * `ESC p` and then `˜π`. Option+N is a dead key on a US layout, and macOS
 * starts its composition before the page sees the keydown, so cancelling the
 * keydown does not stop it; the next key committed the mark and its own
 * Option character, and xterm's composition helper sent them on.
 *
 * jsdom has no IME, so the composition is played the way Chromium plays it:
 * the keydown, then compositionstart / compositionupdate / input with the mark
 * in the textarea, and on the next key the commit and compositionend. xterm's
 * own platform check reads `navigator.platform` (and calls jsdom "node"), so
 * the emulator is told it is on a Mac directly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MacOptionIsMeta } from "../../src/model/macOption";
import {
  openXtermSession,
  type XtermSession,
} from "../../src/shell/surfaces/xtermSession";

// No WebGL in jsdom: the session falls back to xterm's DOM renderer.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      throw new Error("no WebGL context is available");
    }
  },
}));

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

/** Let xterm's and the session's zero-delay timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

let session: XtermSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  document.body.replaceChildren();
});

function open(setting: MacOptionIsMeta) {
  const host = document.createElement("div");
  document.body.append(host);
  session = openXtermSession(host, {
    appearance: {
      terminalFontFamily: "Menlo",
      terminalFontSize: 13,
      terminalLineHeight: 1,
      terminalScrollSensitivity: 3,
      terminalMacOptionIsMeta: setting,
    } as never,
    inputLabel: "Example terminal input",
    isHidden: () => false,
    onGeometry: () => undefined,
  });
  const core = (session.terminal as unknown as { _core: { browser: object } })
    ._core;
  core.browser = { ...core.browser, isMac: true };
  const sent: string[] = [];
  session.terminal.onData((data) => sent.push(data));
  const textarea = host.querySelector("textarea")!;

  const key = (
    type: "keydown" | "keyup" | "keypress",
    init: KeyboardEventInit & { keyCode?: number; charCode?: number },
  ) => {
    const event = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    // jsdom leaves the legacy codes at 0; xterm still reads them.
    for (const field of ["keyCode", "charCode", "which"] as const) {
      const value = field === "which" ? init.keyCode : init[field];
      if (value !== undefined) {
        Object.defineProperty(event, field, { value });
      }
    }
    textarea.dispatchEvent(event);
    return event;
  };
  const option = (side: "AltLeft" | "AltRight", type: "keydown" | "keyup") =>
    key(type, {
      code: side,
      key: "Alt",
      keyCode: 18,
      altKey: type === "keydown",
    });

  /** The IME puts `mark` in the textarea as a composition, as Chromium does. */
  const startComposition = (mark: string) => {
    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
    textarea.value += mark;
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", { bubbles: true, data: mark }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: mark,
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  };
  /** The next key commits `text` in place of the mark. */
  const commitComposition = (mark: string, text: string) => {
    textarea.value =
      textarea.value.slice(0, textarea.value.length - mark.length) + text;
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertFromComposition",
        isComposing: true,
      }),
    );
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: text }),
    );
  };

  return { sent, textarea, key, option, startComposition, commitComposition };
}

describe("Option as Meta, against the real emulator", () => {
  it("sends only ESC n ESC p for a left-Option dead key followed by Option+P", async () => {
    const t = open("left");
    t.option("AltLeft", "keydown");
    const n = t.key("keydown", {
      code: "KeyN",
      key: "Dead",
      keyCode: 78,
      altKey: true,
    });
    t.startComposition("˜");
    t.key("keyup", { code: "KeyN", key: "Dead", keyCode: 78, altKey: true });
    const p = t.key("keydown", {
      code: "KeyP",
      key: "π",
      keyCode: 80,
      altKey: true,
    });
    t.commitComposition("˜", "˜π");
    t.key("keyup", { code: "KeyP", key: "π", keyCode: 80, altKey: true });
    t.option("AltLeft", "keyup");
    await settle();

    expect(t.sent.join("")).toBe("\u001bn\u001bp");
    expect(n.defaultPrevented).toBe(true);
    expect(p.defaultPrevented).toBe(true);
    // Nothing left in the scratch pad for a later composition to slice from.
    expect(t.textarea.value).toBe("");
  });

  it("does the same under true", async () => {
    const t = open(true);
    t.option("AltRight", "keydown");
    t.key("keydown", { code: "KeyE", key: "Dead", keyCode: 69, altKey: true });
    t.startComposition("´");
    t.key("keydown", { code: "KeyE", key: "Dead", keyCode: 69, altKey: true });
    t.commitComposition("´", "´´");
    await settle();

    expect(t.sent.join("")).toBe("\u001be\u001be");
  });

  it("still composes with the right Option under left: Option+E then e is é", async () => {
    const t = open("left");
    t.option("AltRight", "keydown");
    t.key("keydown", { code: "KeyE", key: "Dead", keyCode: 229, altKey: true });
    t.startComposition("´");
    t.key("keyup", { code: "KeyE", key: "Dead", keyCode: 69, altKey: true });
    t.option("AltRight", "keyup");
    t.key("keydown", { code: "KeyE", key: "é", keyCode: 229 });
    t.commitComposition("´", "é");
    await settle();

    expect(t.sent.join("")).toBe("é");
  });

  it("still composes under false", async () => {
    const t = open(false);
    t.option("AltLeft", "keydown");
    t.key("keydown", { code: "KeyE", key: "Dead", keyCode: 229, altKey: true });
    t.startComposition("´");
    t.option("AltLeft", "keyup");
    t.key("keydown", { code: "KeyE", key: "é", keyCode: 229 });
    t.commitComposition("´", "é");
    await settle();

    expect(t.sent.join("")).toBe("é");
  });

  it("types the JIS backslash with the right Option under left", async () => {
    const t = open("left");
    t.option("AltRight", "keydown");
    const down = t.key("keydown", {
      code: "IntlYen",
      key: "\\",
      keyCode: 220,
      altKey: true,
    });
    t.key("keypress", {
      code: "IntlYen",
      key: "\\",
      keyCode: 92,
      charCode: 92,
      altKey: true,
    });
    await settle();

    expect(down.defaultPrevented).toBe(false);
    expect(t.sent.join("")).toBe("\\");
  });

  it("sends ESC backslash for the left Option+¥ under left", async () => {
    const t = open("left");
    t.option("AltLeft", "keydown");
    t.key("keydown", {
      code: "IntlYen",
      key: "\\",
      keyCode: 220,
      altKey: true,
    });
    await settle();

    expect(t.sent.join("")).toBe("\u001b\\");
  });
});
