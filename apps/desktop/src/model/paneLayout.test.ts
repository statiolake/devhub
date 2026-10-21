import { describe, expect, it } from "vitest";
import {
  CONTENT_PANE,
  PANE_MAX_RATIO,
  PANE_MIN_RATIO,
  PaneRecordError,
  layoutRects,
  movePane,
  neighbourPane,
  paneFromRecord,
  paneLeaves,
  paneRecord,
  paneTerminals,
  relativePositions,
  removePane,
  resizePane,
  resolvePane,
  samePaneTree,
  splitPane,
  swapPanes,
  terminalPane,
  type PaneNode,
} from "./paneLayout.js";

const A = terminalPane("a");
const B = terminalPane("b");
const C = terminalPane("c");

/** Content on the left, `a` on the right. */
function right(): PaneNode {
  return splitPane(CONTENT_PANE, CONTENT_PANE, "right", A);
}

describe("splitting", () => {
  it("puts the new pane on the side asked for", () => {
    expect(right()).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.5,
      first: CONTENT_PANE,
      second: A,
    });
    expect(splitPane(CONTENT_PANE, CONTENT_PANE, "below", A)).toMatchObject({
      axis: "column",
      first: CONTENT_PANE,
      second: A,
    });
    expect(splitPane(CONTENT_PANE, CONTENT_PANE, "left", A)).toMatchObject({
      axis: "row",
      first: A,
      second: CONTENT_PANE,
    });
    expect(splitPane(CONTENT_PANE, CONTENT_PANE, "above", A)).toMatchObject({
      axis: "column",
      first: A,
      second: CONTENT_PANE,
    });
  });

  it("keeps the ratio as the existing pane's share on every side", () => {
    expect(
      splitPane(CONTENT_PANE, CONTENT_PANE, "right", A, 0.7),
    ).toMatchObject({ ratio: 0.7 });
    expect(splitPane(CONTENT_PANE, CONTENT_PANE, "left", A, 0.7)).toMatchObject(
      { ratio: expect.closeTo(0.3, 10) },
    );
  });

  it("nests: splitting a terminal splits only that terminal", () => {
    const tree = splitPane(right(), A, "below", B);
    expect(paneLeaves(tree)).toEqual([CONTENT_PANE, A, B]);
    expect(tree).toMatchObject({
      axis: "row",
      first: CONTENT_PANE,
      second: { axis: "column", first: A, second: B },
    });
  });

  it("refuses a pane twice, and a pane that is not there", () => {
    const tree = right();
    expect(splitPane(tree, CONTENT_PANE, "below", A)).toBe(tree);
    expect(splitPane(tree, B, "below", C)).toBe(tree);
  });
});

describe("closing", () => {
  it("gives the sibling the split's place", () => {
    const tree = splitPane(right(), A, "below", B);
    expect(removePane(tree, A)).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.5,
      first: CONTENT_PANE,
      second: B,
    });
    expect(removePane(removePane(tree, A), B)).toEqual(CONTENT_PANE);
  });

  it("never removes the content", () => {
    const tree = right();
    expect(removePane(tree, CONTENT_PANE)).toBe(tree);
    expect(removePane(tree, C)).toBe(tree);
  });
});

describe("resizing", () => {
  it("moves the seam at a path and clamps it", () => {
    const tree = splitPane(right(), A, "below", B);
    expect(resizePane(tree, "", 0.3)).toMatchObject({ ratio: 0.3 });
    expect(resizePane(tree, "1", 0.8)).toMatchObject({
      ratio: 0.5,
      second: { ratio: 0.8 },
    });
    expect(resizePane(tree, "", 0)).toMatchObject({ ratio: PANE_MIN_RATIO });
    expect(resizePane(tree, "", 2)).toMatchObject({ ratio: PANE_MAX_RATIO });
  });

  it("ignores a path that names no split", () => {
    const tree = right();
    expect(resizePane(tree, "0", 0.3)).toBe(tree);
    expect(resizePane(tree, "11", 0.3)).toBe(tree);
  });
});

describe("moving", () => {
  it("takes a terminal out and splits the target with it", () => {
    const tree = splitPane(right(), A, "below", B);
    const moved = movePane(tree, B, CONTENT_PANE, "below");
    expect(moved).toMatchObject({
      axis: "row",
      first: { axis: "column", first: CONTENT_PANE, second: B },
      second: A,
    });
    expect(paneTerminals(moved)).toEqual(["b", "a"]);
  });

  it("does nothing for the content or a drop on itself", () => {
    const tree = right();
    expect(movePane(tree, CONTENT_PANE, A, "right")).toBe(tree);
    expect(movePane(tree, A, A, "left")).toBe(tree);
  });

  it("swaps two leaves in place", () => {
    const swapped = swapPanes(right(), CONTENT_PANE, A);
    expect(swapped).toMatchObject({ first: A, second: CONTENT_PANE });
  });
});

describe("rectangles", () => {
  it("tiles the area exactly, seams included", () => {
    const tree = splitPane(right(), A, "below", B);
    const { panes, seams } = layoutRects(
      tree,
      { x: 100, y: 10, width: 1006, height: 606 },
      6,
    );
    expect(panes).toEqual([
      { leaf: CONTENT_PANE, rect: { x: 100, y: 10, width: 500, height: 606 } },
      { leaf: A, rect: { x: 606, y: 10, width: 500, height: 300 } },
      { leaf: B, rect: { x: 606, y: 316, width: 500, height: 300 } },
    ]);
    expect(seams.map((seam) => [seam.path, seam.axis, seam.rect])).toEqual([
      ["", "row", { x: 600, y: 10, width: 6, height: 606 }],
      ["1", "column", { x: 606, y: 310, width: 500, height: 6 }],
    ]);
  });
});

describe("keyboard neighbours", () => {
  // content | a
  //         | b
  const tree = splitPane(right(), A, "below", B);

  it("finds the pane on each side", () => {
    expect(neighbourPane(tree, CONTENT_PANE, "right")).toEqual(A);
    expect(neighbourPane(tree, A, "below")).toEqual(B);
    expect(neighbourPane(tree, B, "above")).toEqual(A);
    expect(neighbourPane(tree, B, "left")).toEqual(CONTENT_PANE);
  });

  it("does not wrap at the edge", () => {
    expect(neighbourPane(tree, CONTENT_PANE, "left")).toBeUndefined();
    expect(neighbourPane(tree, A, "right")).toBeUndefined();
  });
});

describe("relative positions", () => {
  it("says right and below for the two simple splits", () => {
    expect(relativePositions(right())).toMatchObject([
      {
        terminalId: "a",
        sides: ["right"],
        description: "right",
        adjacent: true,
      },
    ]);
    const below = splitPane(CONTENT_PANE, CONTENT_PANE, "below", A);
    expect(relativePositions(below)).toMatchObject([
      { terminalId: "a", sides: ["below"], description: "below" },
    ]);
  });

  it("tells stacked panes on one side apart", () => {
    const tree = splitPane(right(), A, "below", B);
    expect(relativePositions(tree)).toMatchObject([
      { terminalId: "a", description: "right, top", adjacent: true },
      { terminalId: "b", description: "right, bottom", adjacent: true },
    ]);
  });

  it("names a corner pane by both sides", () => {
    // content | a
    // ----------
    //    c
    // with c spanning the bottom: c is below content, and a is right of it.
    const tree = splitPane(right(), CONTENT_PANE, "below", C);
    const positions = relativePositions(tree);
    expect(positions.find((one) => one.terminalId === "c")).toMatchObject({
      sides: ["below"],
    });
    // A pane below a's column and not under content is off its corner.
    const corner = splitPane(right(), A, "below", B);
    const placedB = relativePositions(corner).find(
      (one) => one.terminalId === "b",
    );
    expect(placedB?.sides).toEqual(["right"]);
    const diagonal: PaneNode = {
      kind: "split",
      axis: "column",
      ratio: 0.5,
      first: {
        kind: "split",
        axis: "row",
        ratio: 0.5,
        first: CONTENT_PANE,
        second: A,
      },
      second: { kind: "split", axis: "row", ratio: 0.5, first: C, second: B },
    };
    expect(
      relativePositions(diagonal).find((one) => one.terminalId === "b"),
    ).toMatchObject({ sides: ["right", "below"], description: "right, below" });
  });

  it("is measured from the content wherever the content is", () => {
    const tree = splitPane(CONTENT_PANE, CONTENT_PANE, "left", A);
    expect(relativePositions(tree)).toMatchObject([{ description: "left" }]);
  });
});

describe("resolving a direction", () => {
  it("finds the only terminal on that side", () => {
    expect(resolvePane(right(), "right")).toEqual({
      kind: "found",
      terminalId: "a",
    });
    expect(resolvePane(right(), "below")).toEqual({ kind: "none" });
  });

  it("is ambiguous between two equally near panes, and a qualifier picks", () => {
    const tree = splitPane(right(), A, "below", B);
    const answer = resolvePane(tree, "right");
    expect(answer.kind).toBe("ambiguous");
    if (answer.kind === "ambiguous") {
      expect(answer.candidates.map((one) => one.terminalId)).toEqual([
        "a",
        "b",
      ]);
    }
    expect(resolvePane(tree, "right bottom")).toEqual({
      kind: "found",
      terminalId: "b",
    });
    expect(resolvePane(tree, "right,top")).toEqual({
      kind: "found",
      terminalId: "a",
    });
  });

  it("prefers the nearest of several on one side", () => {
    // content | a | b
    const tree = splitPane(right(), A, "right", B);
    expect(resolvePane(tree, "right")).toEqual({
      kind: "found",
      terminalId: "a",
    });
  });

  it("knows no side it was not given", () => {
    expect(resolvePane(right(), "sideways")).toEqual({ kind: "none" });
  });
});

describe("persistence", () => {
  it("round-trips through its record", () => {
    const tree = resizePane(splitPane(right(), A, "below", B), "1", 0.3);
    const record = JSON.parse(JSON.stringify(paneRecord(tree))) as unknown;
    const back = paneFromRecord(record);
    expect(samePaneTree(back, tree)).toBe(true);
  });

  it("refuses what it could not have written", () => {
    expect(() =>
      paneFromRecord({ kind: "terminal", terminal_id: "a" }),
    ).toThrow(PaneRecordError);
    expect(() =>
      paneFromRecord({
        kind: "split",
        axis: "row",
        ratio: 0.5,
        first: { kind: "content" },
        second: { kind: "content" },
      }),
    ).toThrow(PaneRecordError);
    expect(() =>
      paneFromRecord({
        kind: "split",
        axis: "diagonal",
        ratio: 0.5,
        first: { kind: "content" },
        second: { kind: "terminal", terminal_id: "a" },
      }),
    ).toThrow(PaneRecordError);
    expect(() =>
      paneFromRecord({
        kind: "split",
        axis: "row",
        ratio: 1.5,
        first: { kind: "content" },
        second: { kind: "terminal", terminal_id: "a" },
      }),
    ).toThrow(PaneRecordError);
  });
});
