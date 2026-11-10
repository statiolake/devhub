// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PART_Z, type GridPainter, type MotionGroup } from "./painter";
import { PANE_MS } from "./paneMotion";
import {
  initialUiState,
  layoutGrids,
  type GridPlacement,
  type NeovimUiState,
} from "./redraw";
import { WindowMotion, anchorWindowOf } from "./windowMotion";

const cell = { width: 8, height: 16 };

const group = (): MotionGroup => {
  const div = () => document.createElement("div");
  return {
    outer: div(),
    clipA: div(),
    clipB: div(),
    content: div(),
    edges: div(),
  };
};

/** The painter's side of a window's motion, recorded. */
function fakePainter() {
  const windows = new Map<number, MotionGroup>();
  const carried: { key: string; z: number; floats: number[] }[] = [];
  const carriers = new Map<string, MotionGroup>();
  let ended = 0;
  const painter = {
    cell: () => cell,
    picture: () => undefined,
    footerOf: () => undefined,
    footerPicture: () => undefined,
    groundOf: () => undefined,
    hairline: () => 0.5,
    hideBoundaries: () => undefined,
    endMotion: () => {
      ended += 1;
      windows.clear();
      carriers.clear();
    },
    motionGroup: (grid: number) => {
      let g = windows.get(grid);
      if (!g) {
        g = group();
        windows.set(grid, g);
      }
      return g;
    },
    atBufpos: (win: number) => win === 1006,
    carryFloats: (key: string, z: number, floats: readonly number[]) => {
      carried.push({ key, z, floats: [...floats] });
      let g = carriers.get(key);
      if (!g) {
        g = group();
        carriers.set(key, g);
      }
      return g;
    },
  };
  return {
    painter: painter as unknown as GridPainter,
    windows,
    carried,
    carriers,
    ended: () => ended,
  };
}

const grid = (id: number, width: number, height: number) => ({
  id,
  width,
  height,
  chars: new Array<string>(width * height).fill(" "),
  hls: new Int32Array(width * height),
  dirty: new Set<number>(),
});

/** Two windows side by side, or the right one alone; floats on the right one. */
function stateWith(
  wins: readonly {
    grid: number;
    col: number;
    width: number;
    topline?: number;
  }[],
): NeovimUiState {
  const state = initialUiState();
  state.grids.set(1, grid(1, 81, 30));
  const place = (grid: number, placement: GridPlacement, topline?: number) =>
    state.windows.set(grid, {
      grid,
      placement,
      hidden: false,
      ...(topline === undefined
        ? {}
        : {
            viewport: {
              topline,
              botline: topline + 27,
              curline: topline,
              curcol: 0,
              lineCount: 100,
            },
          }),
    } as never);
  for (const w of wins) {
    state.grids.set(w.grid, grid(w.grid, w.width, 27));
    place(
      w.grid,
      {
        kind: "window",
        win: 1000 + w.grid,
        row: 0,
        col: w.col,
        width: w.width,
        height: 27,
      },
      w.topline,
    );
  }
  const float = (g: number, anchorGrid: number, row: number, col: number) => {
    state.grids.set(g, grid(g, 20, 3));
    place(g, {
      kind: "float",
      win: 1000 + g,
      anchor: "NW",
      anchorGrid,
      anchorRow: row,
      anchorCol: col,
      focusable: false,
      zindex: 50,
    });
  };
  float(5, 3, 2, 4); // relative='win' on the right window
  float(6, 3, 10, 2); // at a buffer position in it
  float(7, 5, 1, 1); // anchored to the first float
  float(8, 1, 20, 2); // relative='editor'
  state.cursor.grid = 3;
  return state;
}

/** The (x, y) a transform translates by. */
const translate = (el: HTMLElement) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
};

describe("floats anchored to a moving window", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    Object.defineProperty(root, "offsetParent", { get: () => document.body });
    Object.defineProperty(root, "clientWidth", { get: () => 81 * cell.width });
    Object.defineProperty(root, "clientHeight", {
      get: () => 30 * cell.height,
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (
    before: NeovimUiState,
    after: NeovimUiState,
    fake: ReturnType<typeof fakePainter>,
  ) => {
    const motion = new WindowMotion(fake.painter, root);
    const opts = (now: number) => ({
      now,
      cmdheight: 2,
      immediate: false,
      separator: "#888",
      draw: () => undefined,
    });
    motion.paint(before, layoutGrids(before), opts(0));
    motion.paint(after, layoutGrids(after), opts(1000));
    return motion;
  };

  it("finds the window a float hangs from, through floats, and none for the editor's", () => {
    const state = stateWith([{ grid: 3, col: 41, width: 40 }]);
    expect(anchorWindowOf(state, 5)).toBe(3);
    expect(anchorWindowOf(state, 7)).toBe(3);
    expect(anchorWindowOf(state, 8)).toBeUndefined();
    expect(anchorWindowOf(state, 3)).toBeUndefined();
  });

  it("carries them in a group of their own, in their level, with their window's content, from where they were to where they rest", () => {
    // The left window closed: the right one grows to the left.
    const before = stateWith([
      { grid: 2, col: 0, width: 40 },
      { grid: 3, col: 41, width: 40 },
    ]);
    const after = stateWith([{ grid: 3, col: 0, width: 81 }]);
    const fake = fakePainter();
    const motion = run(before, after, fake);
    expect(motion.moving).toBe(true);
    // One carrier for the window's floats at its corner (the nested float
    // too), one for the one at its text; the editor's float is not carried.
    expect(fake.carried).toEqual([
      { key: "3:150:win", z: 150, floats: [5, 7] },
      { key: "3:150:text", z: 150, floats: [6] },
    ]);
    const win = fake.windows.get(3)!;
    const carrier = fake.carriers.get("3:150:win")!;
    // The first frame: where the window's content was, 41 columns right.
    expect(translate(carrier.content)).toEqual({ x: 41 * cell.width, y: 0 });
    // Not cut by the window's clip: its clips are the surface's.
    expect(translate(carrier.clipA)).toEqual({ x: 0, y: 0 });
    expect(translate(carrier.clipB)).toEqual({ x: 0, y: 0 });
    expect(carrier.outer.style.zIndex).toBe(String(PART_Z.grid));
    // Mid-way: the same offset as the window's content, frame by frame.
    for (const ms of [20, 60, 100, 150]) {
      motion.frame(1000 + ms);
      const content = translate(win.content)!;
      const clipB = translate(win.clipB)!;
      const clipA = translate(win.clipA)!;
      // The window's content is at (W - R + dx, H - B + dy) inside its
      // clips at (L, T) and (R - L - W, B - T - H): on screen, dx.
      const dx = clipA.x + clipB.x + content.x;
      const dy = clipA.y + clipB.y + content.y;
      expect(translate(carrier.content)).toEqual({ x: dx, y: dy });
      expect(dx).toBeGreaterThan(0);
      expect(dx).toBeLessThan(41 * cell.width);
    }
    // At the end: at rest, the groups let go of.
    const ended = fake.ended();
    motion.frame(1000 + PANE_MS.structural);
    expect(motion.moving).toBe(false);
    expect(fake.ended()).toBe(ended + 1);
  });

  it("moves one at the window's corner without the rows its text moved; one at its text with them", () => {
    // A split below: the right window shorter, its text scrolled 7 rows.
    const before = stateWith([
      { grid: 2, col: 0, width: 40 },
      { grid: 3, col: 41, width: 40, topline: 1 },
    ]);
    const after = stateWith([
      { grid: 2, col: 0, width: 40 },
      { grid: 3, col: 41, width: 40, topline: 8 },
    ]);
    after.grids.set(3, grid(3, 40, 13));
    const p = after.windows.get(3)!.placement;
    if (p.kind === "window")
      after.windows.get(3)!.placement = { ...p, height: 13 };
    after.grids.set(4, grid(4, 40, 13));
    after.windows.set(4, {
      grid: 4,
      hidden: false,
      placement: {
        kind: "window",
        win: 1004,
        row: 14,
        col: 41,
        width: 40,
        height: 13,
      },
    } as never);
    const fake = fakePainter();
    const motion = run(before, after, fake);
    const corner = fake.carriers.get("3:150:win")!;
    const text = fake.carriers.get("3:150:text")!;
    // The window's corner does not move; its text starts 7 rows lower.
    expect(translate(corner.content)).toEqual({ x: 0, y: 0 });
    expect(translate(text.content)).toEqual({ x: 0, y: 7 * cell.height });
    motion.frame(1000 + 80);
    expect(translate(corner.content)).toEqual({ x: 0, y: 0 });
    const mid = translate(text.content)!.y;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(7 * cell.height);
  });
});
