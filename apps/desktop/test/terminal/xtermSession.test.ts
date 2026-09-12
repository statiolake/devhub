// @vitest-environment jsdom

/**
 * The shared emulator setup, from the outside.
 *
 * Two things are worth pinning here, and both are things the viewer saw go
 * wrong. The font family xterm is handed has to be a CSS value CSS can
 * resolve — an apostrophe carried into a family name asks for a font no
 * machine has, and the whole stack falls through to its trailing generic. And
 * the renderer a surface got has to be knowable: the GPU one draws every cell
 * on a whole-pixel grid, the fallback approximates the grid with one
 * `letter-spacing` per run of text, and a surface that quietly lands on the
 * fallback just looks blurry with CJK punctuation sprawling past its cells.
 *
 * jsdom cannot host a real emulator — the suite mocks xterm for exactly that
 * reason — so what is tested here is the decision, not the drawing. The
 * drawing is measured in a browser; see the harness under `.spike/xtermfix/`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webglFails: false,
  loaded: [] as string[],
  loseContext: undefined as (() => void) | undefined,
  disposedWebgl: false,
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    readonly options: Record<string, unknown> = {};
    constructor(options: Record<string, unknown> = {}) {
      Object.assign(this.options, options);
    }
    loadAddon(addon: {
      readonly kind?: string;
      activate?: (terminal: unknown) => void;
    }) {
      if (addon.kind) mocks.loaded.push(addon.kind);
      if (addon.kind === "webgl" && mocks.webglFails) {
        throw new Error("no WebGL context is available");
      }
      // Real xterm activates an addon as it loads it, which is when the
      // clipboard addon registers its OSC 52 handler.
      addon.activate?.(this);
    }
    open(host: HTMLElement) {
      const element = document.createElement("div");
      element.className = "xterm";
      element.append(document.createElement("textarea"));
      host.append(element);
    }
    readonly sent: string[] = [];
    readonly oscHandlers: ((data: string) => boolean | Promise<boolean>)[] = [];
    readonly parser = {
      registerOscHandler: (
        ident: number,
        handler: (data: string) => boolean | Promise<boolean>,
      ) => {
        if (ident !== 52) throw new Error(`unexpected OSC ${ident} handler`);
        this.oscHandlers.push(handler);
        return { dispose: () => undefined };
      },
    };
    /**
     * Dispatch an OSC sequence the way xterm's parser does: the most recently
     * registered handler first, stopping at the first one that returns true.
     * That order is the whole of how the query guard gets in front of the
     * clipboard addon, so a mock that dispatched any other way would prove
     * nothing.
     */
    async write(data: string) {
      const opener = "\u001b]52;";
      if (!data.startsWith(opener) || !data.endsWith("\u0007")) {
        throw new Error(`the mock only speaks OSC 52: ${data}`);
      }
      const body = data.slice(opener.length, -1);
      for (let i = this.oscHandlers.length - 1; i >= 0; i--) {
        if (await this.oscHandlers[i](body)) return;
      }
    }
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    input(data: string) {
      this.sent.push(data);
    }
    focus() {}
    dispose() {}
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    readonly kind = "fit";
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    readonly kind = "webgl";
    onContextLoss(handler: () => void) {
      mocks.loseContext = handler;
      return { dispose: () => undefined };
    }
    dispose() {
      mocks.disposedWebgl = true;
    }
  },
}));

const { openXtermSession } = await import(
  "../../src/shell/surfaces/xtermSession"
);

function open(terminalFontFamily?: string) {
  const host = document.createElement("div");
  document.body.append(host);
  return openXtermSession(host, {
    appearance:
      terminalFontFamily === undefined
        ? undefined
        : ({
            terminalFontFamily,
            terminalFontSize: 13,
            terminalLineHeight: 1.2,
            terminalScrollSensitivity: 3,
          } as never),
    inputLabel: "Example terminal input",
    isHidden: () => false,
    onGeometry: () => undefined,
  });
}

/** The base64 payload of an OSC 52 write, as a program in the pane sends it. */
function osc52(payload: string): string {
  return `\u001b]52;c;${payload}\u0007`;
}

beforeEach(() => {
  mocks.webglFails = false;
  mocks.loaded.length = 0;
  mocks.loseContext = undefined;
  mocks.disposedWebgl = false;
});

describe("the shared xterm session", () => {
  it("draws through the GPU renderer, not the fallback", () => {
    const session = open();
    expect(mocks.loaded).toContain("webgl");
    expect(session.renderer).toBe("webgl");
    session.dispose();
  });

  it("records the fallback rather than quietly drawing degraded", () => {
    mocks.webglFails = true;
    const session = open();
    // A machine with no WebGL context still gets a terminal — but the surface
    // knows it is the fallback, instead of the difference showing up only as
    // blur nobody can attribute.
    expect(session.renderer).toBe("dom");
    session.dispose();
  });

  it("stops claiming the GPU renderer once its context is gone", () => {
    const session = open();
    expect(session.renderer).toBe("webgl");
    // A browser hands out a bounded number of contexts, so a page with enough
    // surfaces loses the oldest. The addon then draws nothing at all until it
    // is disposed, and a `renderer` still reading "webgl" would be the same
    // silent lie as never having reported it.
    mocks.loseContext?.();
    expect(mocks.disposedWebgl).toBe(true);
    expect(session.renderer).toBe("dom");
    session.dispose();
  });

  it("hands xterm a font-family CSS can resolve, quotes and all", () => {
    const session = open("'Cascadia Code NF', 'Noto Sans JP'");
    const stack = String(session.terminal.options.fontFamily);
    expect(stack).toContain('"Cascadia Code NF"');
    expect(stack).toContain('"Noto Sans JP"');
    // The apostrophe is the whole reported bug: it names a family no system
    // has, so nothing before the trailing generic ever matches.
    expect(stack).not.toContain("'");
    expect(stack.endsWith("monospace")).toBe(true);
    session.dispose();
  });

  /**
   * A program in the pane asks what it is drawing on with OSC 11, and xterm
   * answers from its theme. With no configured palette xterm used to keep its
   * built-in black while CSS painted the pane the app's own ground, so a light
   * pane reported itself dark and a TUI chose the wrong colours for it.
   */
  it("names the ground it is painted when no palette is configured", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(255, 255, 255)";
    host.style.color = "rgb(0, 0, 0)";
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    const theme = session.terminal.options.theme as Record<string, string>;
    expect(theme.background).toBe("rgb(255, 255, 255)");
    expect(theme.foreground).toBe("rgb(0, 0, 0)");
    session.dispose();
  });

  it("follows the ground when the scheme moves under an unconfigured pane", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    // The palette stays undefined across a scheme change when no theme is
    // configured, which is exactly the case that used to go unreported.
    host.style.backgroundColor = "rgb(30, 30, 30)";
    session.applyTheme(undefined);
    expect(
      (session.terminal.options.theme as Record<string, string>).background,
    ).toBe("rgb(30, 30, 30)");
    session.dispose();
  });

  /**
   * Re-applying the same colours must not repaint the screen.
   *
   * `options.theme` takes an object and xterm cannot compare two equal ones, so
   * every assignment rebuilds the colour set and repaints — cursor included.
   * Under a cursor an application has asked to keep steady, a repaint is
   * indistinguishable from a blink, so "the colours did not change" has to mean
   * "nothing happened".
   */
  it("does not hand xterm a theme it is already using", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    const palette = {
      background: "#123456",
      foreground: "#abcdef",
      cursor: "#ffffff",
      cursorText: "#000000",
      selectionBackground: "#333333",
      selectionForeground: "#ffffff",
      ansi: Array.from({ length: 16 }, () => "#010101"),
    };
    session.applyTheme(palette);
    const applied = session.terminal.options.theme;
    // An equal palette, built separately: the same colours, a different object.
    session.applyTheme({ ...palette, ansi: [...palette.ansi] });
    expect(session.terminal.options.theme).toBe(applied);
    // A real change still gets through.
    session.applyTheme({ ...palette, background: "#654321" });
    expect(session.terminal.options.theme).not.toBe(applied);
    session.dispose();
  });

  it("prefers a configured palette over the painted ground", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    session.applyTheme({
      background: "#123456",
      foreground: "#abcdef",
      cursor: "#ffffff",
      cursorText: "#000000",
      selectionBackground: "#333333",
      selectionForeground: "#ffffff",
      ansi: Array.from({ length: 16 }, () => "#010101"),
    });
    expect(
      (session.terminal.options.theme as Record<string, string>).background,
    ).toBe("#123456");
    session.dispose();
  });

  /**
   * The reported gesture: type Japanese, press Cmd+Left, type Japanese again,
   * and the second input came out as the tail of the first.
   *
   * xterm decides what a composition produced by slicing its textarea from the
   * offset it recorded when the composition began, which assumes the caret is
   * at the end. Cmd+Left is a key xterm has no binding for, so the browser
   * moved the caret in the textarea and the offset sliced from the wrong
   * place. What this pins is the repair: nothing is left in the textarea
   * between compositions, so no caret position in it can mean anything.
   */
  it("leaves nothing in the IME scratch pad for a caret move to strand", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    const area = host.querySelector("textarea") as HTMLTextAreaElement;

    // What the IME leaves behind when a composition is committed.
    area.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    area.value = "\u65e5\u672c\u8a9e";
    area.selectionStart = area.selectionEnd = 3;
    area.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "\u65e5\u672c\u8a9e",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Emptied, so Cmd+Left has no stale text to strand the next composition on.
    expect(area.value).toBe("");
    expect(area.selectionStart).toBe(0);
    session.dispose();
  });

  it("keeps the scratch pad alone while a composition is still in flight", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const session = openXtermSession(host, {
      inputLabel: "Example terminal input",
      isHidden: () => false,
      onGeometry: () => undefined,
    });
    const area = host.querySelector("textarea") as HTMLTextAreaElement;

    area.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    area.value = "\u306b\u307b";
    area.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still being composed: emptying it here would destroy the input.
    expect(area.value).toBe("\u306b\u307b");
    session.dispose();
  });

  /**
   * The rule is tested on its own in `keys.test.ts`; what is pinned here is
   * that the session actually hands it to xterm, and what it does with the
   * answer.
   *
   * Three things have to hold together for Cmd+Left to reach the program in
   * the pane and nothing else: the bytes go in as terminal input, the browser's
   * own default — the caret move in the hidden textarea — is prevented, and
   * xterm is told to stop, so it does not also spell the key its own way.
   */
  it("answers a Mac editing chord as terminal input and stops there", () => {
    const session = open();
    const terminal = session.terminal as unknown as {
      keyHandler: (event: KeyboardEvent) => boolean;
      sent: string[];
    };
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      metaKey: true,
      cancelable: true,
    });

    expect(terminal.keyHandler(event)).toBe(false);
    expect(terminal.sent).toEqual(["\u0001"]);
    expect(event.defaultPrevented).toBe(true);
    session.dispose();
  });

  /**
   * Cmd+C has to keep reaching the browser and DevHub's menus. Returning true
   * without touching the event is what leaves it alone; a keyup is left alone
   * for the same reason, since the chord was already answered on the way down.
   */
  it("leaves a key that is not ours to xterm and to the browser", () => {
    const session = open();
    const terminal = session.terminal as unknown as {
      keyHandler: (event: KeyboardEvent) => boolean;
      sent: string[];
    };
    const copy = new KeyboardEvent("keydown", {
      key: "c",
      metaKey: true,
      cancelable: true,
    });
    const release = new KeyboardEvent("keyup", {
      key: "ArrowLeft",
      metaKey: true,
      cancelable: true,
    });
    expect(terminal.keyHandler(copy)).toBe(true);
    expect(terminal.keyHandler(release)).toBe(true);
    expect(terminal.sent).toEqual([]);
    expect(copy.defaultPrevented).toBe(false);
    expect(release.defaultPrevented).toBe(false);
    session.dispose();
  });

  it("keeps the font a CSS value when the appearance changes later", () => {
    const session = open("Menlo");
    session.applyAppearance({
      terminalFontFamily: "'Cascadia Code NF'",
      terminalFontSize: 14,
      terminalLineHeight: 1.3,
      terminalScrollSensitivity: 5,
    } as never);
    expect(String(session.terminal.options.fontFamily)).not.toContain("'");
    expect(String(session.terminal.options.fontFamily)).toContain(
      '"Cascadia Code NF"',
    );
    session.dispose();
  });

  it("scrolls by what the appearance says, at open and when it changes", () => {
    // xterm.js turns one wheel event into at most one mouse report, so this
    // multiplier is the whole of how far an Agent pane moves per notch.
    const session = open("Menlo");
    expect(session.terminal.options.scrollSensitivity).toBe(3);
    session.applyAppearance({
      terminalFontFamily: "Menlo",
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      terminalScrollSensitivity: 5,
    } as never);
    expect(session.terminal.options.scrollSensitivity).toBe(5);
    session.dispose();
  });
});

/**
 * Copying inside the pane.
 *
 * tmux's copy-mode has no other way to reach a Mac's clipboard from a machine
 * on the far end of an SSH connection: it writes `ESC ] 52 ; c ; <base64> BEL`
 * into the stream and the outer terminal is what puts the text on the
 * clipboard. VS Code's integrated terminal and Ghostty both do; before the
 * clipboard addon, DevHub swallowed the sequence and a copy did nothing.
 */
describe("OSC 52", () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    window.devhub = {
      writeClipboard: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    } as unknown as typeof window.devhub;
  });

  function feed(session: { terminal: unknown }, data: string): Promise<void> {
    return (session.terminal as { write(data: string): Promise<void> }).write(
      data,
    );
  }

  it("puts what a program copied on the Mac's clipboard, through main", async () => {
    const session = open();
    await feed(session, osc52(btoa("hello")));
    // Through main rather than `navigator.clipboard`, which refuses a write
    // while the document is unfocused — and a PTY does not wait for the
    // window to be frontmost.
    expect(written).toEqual(["hello"]);
    session.dispose();
  });

  /**
   * The field tmux actually sends is empty.
   *
   * Captured off a tmux 3.7 client attached with `TERM=xterm-256color` and
   * `set-clipboard on`: a copy arrives as `ESC ] 52 ; ; <base64> BEL`, with no
   * `c`. A provider that answered only `c` — which is what the addon's own
   * default does — copied nothing at all from the one program this is for.
   */
  it("copies what tmux sends, whose selection field is empty", async () => {
    const session = open();
    await feed(session, `\u001b]52;;${btoa("copied-from-copy-mode")}\u0007`);
    expect(written).toEqual(["copied-from-copy-mode"]);
    session.dispose();
  });

  it("carries the bytes a copy actually contains, multibyte included", async () => {
    const session = open();
    await feed(session, osc52("44GC44GE44GG"));
    expect(written).toEqual(["\u3042\u3044\u3046"]);
    session.dispose();
  });

  it("says nothing at all when a program asks what is on the clipboard", async () => {
    const session = open();
    const terminal = session.terminal as unknown as { sent: string[] };
    await feed(session, osc52("?"));
    // A reply would hand the Mac's clipboard — a password out of a manager,
    // the last thing copied out of a private file — to whichever program is
    // reading the PTY, which over SSH is a program on somebody else's machine.
    // An empty reply is still a reply, so there is none.
    expect(terminal.sent).toEqual([]);
    expect(written).toEqual([]);
    session.dispose();
  });

  it("leaves the primary selection alone, which a Mac does not have", async () => {
    const session = open();
    await feed(session, `\u001b]52;p;${btoa("hello")}\u0007`);
    expect(written).toEqual([]);
    session.dispose();
  });
});
