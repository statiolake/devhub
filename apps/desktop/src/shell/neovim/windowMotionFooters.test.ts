// @vitest-environment jsdom

/**
 * A window's footer (the element drawn in its status line row) moves with
 * its window: at its group's clip's foot, as wide as the clip, frame by
 * frame; a window that goes keeps a copy of its footer in its group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPainter, MotionGroup } from "./painter";
import { initialUiState, layoutGrids, type NeovimUiState } from "./redraw";
import { WindowMotion } from "./windowMotion";

const cell = { width: 8, height: 16 };
const W = 81;
const H = 30;

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

function fakePainter() {
  const windows = new Map<number, MotionGroup>();
  const footers = new Map<number, HTMLElement>();
  const pictures = new Map<number, HTMLElement>();
  const footerOf = (grid: number) => {
    let el = footers.get(grid);
    if (!el) {
      el = document.createElement("div");
      el.className = "nvim-footer";
      footers.set(grid, el);
    }
    return el;
  };
  const painter = {
    cell: () => cell,
    picture: () => undefined,
    footerOf,
    footerPicture: (grid: number) => {
      const copy = footerOf(grid).cloneNode(true) as HTMLElement;
      copy.classList.add("nvim-footer-picture");
      pictures.set(grid, copy);
      return copy;
    },
    groundOf: () => undefined,
    hairline: () => 0.5,
    hideBoundaries: () => undefined,
    endMotion: () => {
      windows.clear();
    },
    motionGroup: (grid: number) => {
      let g = windows.get(grid);
      if (!g) {
        g = group();
        windows.set(grid, g);
      }
      return g;
    },
    atBufpos: () => false,
    carryFloats: () => group(),
  };
  return {
    painter: painter as unknown as GridPainter,
    windows,
    footers,
    pictures,
  };
}

function stateWith(
  wins: readonly { grid: number; col: number; width: number }[],
): NeovimUiState {
  const state = initialUiState();
  const grid = (id: number, width: number, height: number) => ({
    id,
    width,
    height,
    chars: new Array<string>(width * height).fill(" "),
    hls: new Int32Array(width * height),
    dirty: new Set<number>(),
  });
  state.grids.set(1, grid(1, W, H));
  for (const w of wins) {
    state.grids.set(w.grid, grid(w.grid, w.width, 27));
    state.windows.set(w.grid, {
      grid: w.grid,
      placement: {
        kind: "window",
        win: 1000 + w.grid,
        row: 0,
        col: w.col,
        width: w.width,
        height: 27,
      },
      hidden: false,
    });
  }
  state.cursor.grid = wins[wins.length - 1]?.grid ?? 1;
  return state;
}

/** The (x, y) a transform translates by. */
const translate = (el: HTMLElement) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
};

describe("a window's footer while windows move", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    Object.defineProperty(root, "offsetParent", { get: () => document.body });
    Object.defineProperty(root, "clientWidth", { get: () => W * cell.width });
    Object.defineProperty(root, "clientHeight", { get: () => H * cell.height });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rides its window's clip, and a gone window's copy stays in its own group", () => {
    // The left window closes: the right one grows over it, to the left.
    const before = stateWith([
      { grid: 2, col: 0, width: 40 },
      { grid: 3, col: 41, width: 40 },
    ]);
    const after = stateWith([{ grid: 3, col: 0, width: 81 }]);
    const fake = fakePainter();
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
    expect(motion.moving).toBe(true);
    // The gone window's footer: a copy, in its group's clip, not the live one.
    const gone = fake.pictures.get(2);
    expect(gone).toBeDefined();
    expect(gone?.parentElement).toBe(fake.windows.get(2)?.clipB);
    expect(fake.footers.get(2)?.parentElement ?? null).toBeNull();
    // The staying window's footer: at its clip's foot (the surface's last
    // row but the command line's two), as wide as the clip is at the start
    // (its old width, half a cell into the gap on its left), growing.
    const live = fake.footers.get(3)!;
    const startWidth = parseFloat(live.style.width);
    expect(startWidth).toBeGreaterThan(40 * cell.width - 1);
    expect(startWidth).toBeLessThan(81 * cell.width);
    const at = translate(live);
    expect(at?.y).toBe(H * cell.height - cell.height);
    motion.frame(1000 + 120);
    const later = parseFloat(live.style.width);
    expect(later).toBeGreaterThan(startWidth);
    // At rest: nothing of the motion is left on it.
    motion.frame(1000 + 5000);
    expect(motion.moving).toBe(false);
  });
});
