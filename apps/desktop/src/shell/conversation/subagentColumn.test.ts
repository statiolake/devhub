/**
 * The column's sizes and folds, as numbers: how a sash moves them, where they
 * stop, and what a double-click puts back.
 */

import { describe, expect, it } from "vitest";
import { entryId } from "../../model/conversation";
import {
  clampColumnWidth,
  INITIAL_COLUMN,
  MIN_COLUMN_PX,
  MIN_CONVERSATION_PX,
  MIN_PANE_PX,
  sashesOf,
  weightOf,
  withDefaultWidth,
  withEqualHeights,
  withFold,
  withPanesOf,
  withSashMoved,
  withWidth,
} from "./subagentColumn";

const A = entryId("a");
const B = entryId("b");
const C = entryId("c");

describe("the column's width", () => {
  it("is kept between its own least and what leaves the conversation its least", () => {
    expect(clampColumnWidth(500, 1200)).toBe(500);
    expect(clampColumnWidth(100, 1200)).toBe(MIN_COLUMN_PX);
    expect(clampColumnWidth(1100, 1200)).toBe(1200 - MIN_CONVERSATION_PX);
  });

  it("goes back to its default share on a double-click", () => {
    const dragged = withWidth(INITIAL_COLUMN, 450, 1200);
    expect(dragged.width).toBe(450);
    expect(withDefaultWidth(dragged).width).toBeUndefined();
  });
});

describe("a sash between two panes", () => {
  const open = [
    { id: A, height: 300 },
    { id: B, height: 300 },
    { id: C, height: 200 },
  ];

  it("trades height between the two it lies between, and keeps the rest", () => {
    const moved = withSashMoved(INITIAL_COLUMN, open, 0, 1, 100);
    expect(weightOf(moved, A)).toBe(400);
    expect(weightOf(moved, B)).toBe(200);
    expect(weightOf(moved, C)).toBe(200);
  });

  it("stops where either would go under its least", () => {
    const down = withSashMoved(INITIAL_COLUMN, open, 0, 1, 1000);
    expect(weightOf(down, A)).toBe(600 - MIN_PANE_PX);
    expect(weightOf(down, B)).toBe(MIN_PANE_PX);
    const up = withSashMoved(INITIAL_COLUMN, open, 0, 1, -1000);
    expect(weightOf(up, A)).toBe(MIN_PANE_PX);
    expect(weightOf(up, B)).toBe(600 - MIN_PANE_PX);
  });

  it("moves nothing when the two have no room to give", () => {
    const cramped = [
      { id: A, height: 90 },
      { id: B, height: 90 },
    ];
    expect(withSashMoved(INITIAL_COLUMN, cramped, 0, 1, 20)).toBe(
      INITIAL_COLUMN,
    );
  });

  it("gives a pane that joins afterwards the mean share, and all an equal one on a double-click", () => {
    const moved = withSashMoved(INITIAL_COLUMN, open, 0, 1, 100);
    expect(weightOf(moved, entryId("later"))).toBeCloseTo(800 / 3);
    const reset = withEqualHeights(moved);
    expect(weightOf(reset, A)).toBe(1);
    expect(weightOf(reset, C)).toBe(1);
  });

  it("is refused between panes that are not one above the other", () => {
    expect(() => withSashMoved(INITIAL_COLUMN, open, 1, 1, 10)).toThrow();
    expect(() => withSashMoved(INITIAL_COLUMN, open, 2, 3, 10)).toThrow();
  });
});

describe("folds", () => {
  it("fold and unfold a pane by its id", () => {
    const folded = withFold(INITIAL_COLUMN, B, true);
    expect(folded.folded.has(B)).toBe(true);
    expect(withFold(folded, B, false).folded.has(B)).toBe(false);
  });

  it("leave a sash only between open panes that follow one another", () => {
    expect(sashesOf([true, true, true])).toEqual([
      { before: 1, above: 0, below: 1 },
      { before: 2, above: 1, below: 2 },
    ]);
    // A folded pane between two open ones: one sash, over the lower.
    expect(sashesOf([true, false, true])).toEqual([
      { before: 2, above: 0, below: 1 },
    ]);
    expect(sashesOf([false, true, false])).toEqual([]);
    expect(sashesOf([true])).toEqual([]);
  });
});

describe("a pane that leaves the column", () => {
  const open = [
    { id: A, height: 300 },
    { id: B, height: 100 },
    { id: C, height: 200 },
  ];

  it("takes its share and its fold with it, the rest keeping their proportions", () => {
    const laidOut = withFold(
      withWidth(withSashMoved(INITIAL_COLUMN, open, 0, 1, 0), 450, 1200),
      C,
      true,
    );
    const left = withPanesOf(laidOut, new Set([A, B]));
    expect([...left.weights]).toEqual([
      [A, 300],
      [B, 100],
    ]);
    expect(left.folded.size).toBe(0);
    expect(left.width).toBe(450);
    // Back again, it arrives at an ordinary size, open.
    expect(weightOf(left, C)).toBe(200);
    expect(left.folded.has(C)).toBe(false);
  });

  it("changes nothing while every pane with a size or a fold stays", () => {
    const folded = withFold(INITIAL_COLUMN, A, true);
    expect(withPanesOf(folded, new Set([A, B]))).toBe(folded);
  });
});
