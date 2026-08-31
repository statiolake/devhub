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

  it("keeps the font a CSS value when the appearance changes later", () => {
    const session = open("Menlo");
    session.applyAppearance(
      {
        terminalFontFamily: "'Cascadia Code NF'",
        terminalFontSize: 14,
        terminalLineHeight: 1.3,
      } as never,
      undefined,
    );
    expect(String(session.terminal.options.fontFamily)).not.toContain("'");
    expect(String(session.terminal.options.fontFamily)).toContain(
      '"Cascadia Code NF"',
    );
    session.dispose();
  });
});
