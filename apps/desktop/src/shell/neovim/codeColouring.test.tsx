// @vitest-environment jsdom

/**
 * A popup's code (an LSP hover) is coloured from its first frame and stays
 * coloured: the hover flicker, where the block went plain and coloured
 * again at every redraw of its Neovim.
 *
 * What caused it: `markdownComponents` was made anew at every render, and
 * react-markdown takes each renderer as a component type, so each redraw
 * mounted the code block anew; and a block mounted anew started plain,
 * waiting on a promise for a colouring it already had. Each half is pinned
 * here: a redraw keeps the block's element, a block mounted anew is
 * coloured in its first render, and a block whose grammar is still loading
 * tells the popup, which holds its first frame for it.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { highlight } from "../conversation/highlight";
import { ComponentTree, type ComponentTheme } from "./ComponentView";
import { ColouringWait, HighlightedCode } from "./DecorationViews";
import type { ComponentNode } from "./components";

afterEach(cleanup);

const HOVER = [
  "```python",
  "(function) def greet(",
  "    name: str,",
  "    times: int = 1",
  ") -> str",
  "```",
  "---",
  "Return a greeting for name, repeated times.",
].join("\n");

const CODE =
  "(function) def greet(\n    name: str,\n    times: int = 1\n) -> str";

const NODE = { type: "markdown", text: HOVER } as ComponentNode;

const openLink = () => undefined;

/** The theme a popup builds at each render: a new object, the same look. */
function theme(): ComponentTheme {
  return {
    hl: new Map(),
    fg: 0x000000,
    bg: 0xffffff,
    dark: false,
    mono: "monospace",
    openLink,
    onAction: () => undefined,
  };
}

function coloured(pre: Element | null): number {
  return pre?.querySelectorAll("span[style*='color']").length ?? 0;
}

describe("a popup's code colouring", () => {
  it("tells the popup of a block whose grammar is still loading", async () => {
    const waits: Promise<unknown>[] = [];
    const { container } = render(
      <ColouringWait.Provider value={(p) => waits.push(p)}>
        <HighlightedCode code="fn main() {}" language="rust" dark={false} />
      </ColouringWait.Provider>,
    );
    expect(waits).toHaveLength(1);
    expect(coloured(container.querySelector("pre"))).toBe(0);
    await act(async () => {
      await waits[0];
    });
    expect(coloured(container.querySelector("pre"))).toBeGreaterThan(0);
  });

  it("is coloured in the first render of a block mounted anew", async () => {
    await highlight(CODE, "python");
    const waits: Promise<unknown>[] = [];
    const { container } = render(
      <ColouringWait.Provider value={(p) => waits.push(p)}>
        <ComponentTree node={NODE} theme={theme()} />
      </ColouringWait.Provider>,
    );
    expect(coloured(container.querySelector("pre"))).toBeGreaterThan(0);
    expect(waits).toHaveLength(0);
  });

  it("keeps its element, coloured, through redraws", async () => {
    await highlight(CODE, "python");
    const { container, rerender } = render(
      <ComponentTree node={NODE} theme={theme()} />,
    );
    const pre = container.querySelector("pre");
    expect(coloured(pre)).toBeGreaterThan(0);
    for (let redraw = 0; redraw < 5; redraw++) {
      rerender(<ComponentTree node={{ ...NODE }} theme={theme()} />);
      expect(container.querySelector("pre")).toBe(pre);
      expect(coloured(container.querySelector("pre"))).toBeGreaterThan(0);
    }
  });
});
