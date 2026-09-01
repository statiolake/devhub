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
    loadAddon(addon: { readonly kind?: string }) {
      if (addon.kind) mocks.loaded.push(addon.kind);
      if (addon.kind === "webgl" && mocks.webglFails) {
        throw new Error("no WebGL context is available");
      }
    }
    open(host: HTMLElement) {
      const element = document.createElement("div");
      element.className = "xterm";
      element.append(document.createElement("textarea"));
      host.append(element);
    }
    attachCustomKeyEventHandler() {}
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
          } as never),
    inputLabel: "Example terminal input",
    isHidden: () => false,
    onGeometry: () => undefined,
  });
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

  it("keeps the font a CSS value when the appearance changes later", () => {
    const session = open("Menlo");
    session.applyAppearance({
      terminalFontFamily: "'Cascadia Code NF'",
      terminalFontSize: 14,
      terminalLineHeight: 1.3,
    } as never);
    expect(String(session.terminal.options.fontFamily)).not.toContain("'");
    expect(String(session.terminal.options.fontFamily)).toContain(
      '"Cascadia Code NF"',
    );
    session.dispose();
  });
});
