// @vitest-environment jsdom

/**
 * A list (`stack{ band }`, blink-ui's completion menu) whose rows are
 * clickable: the row pressed has the band at once (`provisional.ts`), its
 * click handed on with how many clicks it is, and Lua's selection wins as
 * soon as it moves.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentTree, type ComponentTheme } from "./ComponentView";
import { parseNode, type ComponentNode } from "./components";
import { PROVISIONAL_TTL_MS } from "./provisional";

afterEach(cleanup);

function list(selected: number): ComponentNode {
  const node = parseNode({
    type: "stack",
    band: "PmenuSel",
    selected,
    children: [1, 2, 3].map((i) => ({
      type: "hstack",
      action: i,
      children: [{ type: "text", text: `item${String(i)}` }],
    })),
  });
  if (!node) throw new Error("not a tree");
  return node;
}

function setup(selected: number) {
  const clicks: [number, number][] = [];
  const theme: ComponentTheme = {
    hl: new Map(),
    fg: 0,
    bg: 0xffffff,
    dark: false,
    mono: "monospace",
    openLink: () => undefined,
    onAction: (action, n) => clicks.push([action, n]),
  };
  const view = render(<ComponentTree node={list(selected)} theme={theme} />);
  const rows = () =>
    Array.from(
      view.container.querySelectorAll<HTMLElement>(
        ".nvc-banded > [data-action]",
      ),
    );
  const rerender = (n: number) =>
    view.rerender(<ComponentTree node={list(n)} theme={theme} />);
  return { clicks, rows, rerender };
}

const selectedRow = (rows: HTMLElement[]) =>
  rows.findIndex((r) => r.classList.contains("nvc-selected")) + 1;

describe("a list's row clicked", () => {
  it("has the band at once, and its click with its count", () => {
    const { clicks, rows } = setup(1);
    expect(selectedRow(rows())).toBe(1);
    fireEvent.mouseDown(rows()[2]!, { detail: 1 });
    expect(selectedRow(rows())).toBe(3);
    fireEvent.mouseDown(rows()[2]!, { detail: 2 });
    expect(clicks).toEqual([
      [3, 1],
      [3, 2],
    ]);
  });

  it("is Lua's as soon as Lua's selection moves, wherever it goes", () => {
    const { rows, rerender } = setup(1);
    fireEvent.mouseDown(rows()[2]!, { detail: 1 });
    rerender(2);
    expect(selectedRow(rows())).toBe(2);
  });

  it("is taken back when Lua never moved", () => {
    vi.useFakeTimers();
    try {
      const { rows } = setup(1);
      fireEvent.mouseDown(rows()[1]!, { detail: 1 });
      expect(selectedRow(rows())).toBe(2);
      act(() => {
        vi.advanceTimersByTime(PROVISIONAL_TTL_MS + 1);
      });
      expect(selectedRow(rows())).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
