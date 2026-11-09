// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ControlToPage, PaneBox } from "../../../ipc/terminalControl";
import type { GridPainter, MotionGroup } from "../../neovim/painter";
import { PANE_MS, plan, type Place } from "../../neovim/paneMotion";
import {
  anchorOf,
  applyMotion,
  changeOf,
  leaving,
  paneUnder,
  restPlace,
  shiftsOf,
  waitingFor,
  type Moving,
  type Shown,
} from "./controlMotion";
import { gridOf, newControlView, type ControlView } from "./paneGrids";

const cell = { width: 8, height: 16.5 };
const dpr = 2;
const pane = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  active = false,
): PaneBox => ({ pane: id, x, y, width, height, active, synchronized: false });

function viewWith(
  panes: readonly PaneBox[],
  text: ReadonlyMap<number, readonly string[]> = new Map(),
): ControlView {
  const view = newControlView({ foreground: 0xffffff, background: 0 });
  view.cols = 80;
  view.rows = 24;
  view.window = 1;
  view.windows = [{ id: 1, index: 0, name: "", active: true, zoomed: false }];
  view.panes = panes;
  for (const p of panes) {
    const rows = text.get(p.pane) ?? [];
    const chars: string[] = [];
    for (let r = 0; r < p.height; r += 1)
      chars.push(...(rows[r] ?? "").padEnd(p.width, " ").slice(0, p.width));
    view.state.grids.set(gridOf(p.pane), {
      id: gridOf(p.pane),
      width: p.width,
      height: p.height,
      chars,
      hls: new Int32Array(p.width * p.height),
      dirty: new Set(),
    });
  }
  return view;
}

function shownOf(view: ControlView, text = new Map<number, string[]>()): Shown {
  return {
    cols: view.cols,
    rows: view.rows,
    window: view.window,
    zoomed: false,
    panes: view.panes,
    text,
    pictures: new Map(),
  };
}

/** A painter's motion groups, without a painter. */
function groups() {
  const made = new Map<number, MotionGroup>();
  const painter = {
    motionGroup(grid: number) {
      let g = made.get(grid);
      if (!g) {
        const div = () => document.createElement("div");
        g = {
          outer: div(),
          clipA: div(),
          clipB: div(),
          content: div(),
          edges: div(),
        };
        made.set(grid, g);
      }
      return g;
    },
  } as unknown as GridPainter;
  return { painter, made };
}

const translate = (t: string) =>
  [...t.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));

/** The rectangle two clips cut, and the content's origin, from the DOM. */
function drawn(g: MotionGroup, size: { width: number; height: number }) {
  const [L, T] = translate(g.clipA.style.transform);
  const [bx, by] = translate(g.clipB.style.transform);
  const [cx, cy] = translate(g.content.style.transform);
  const R = L + bx + size.width;
  const B = T + by + size.height;
  return {
    rect: { left: L, top: T, right: R, bottom: B },
    dx: R + cx - size.width,
    dy: B + cy - size.height,
  };
}

describe("a split, frame by frame", () => {
  const before = viewWith([pane(1, 0, 0, 80, 24, true)]);
  const after = [pane(1, 0, 0, 40, 24), pane(2, 41, 0, 39, 24, true)];
  const size = { width: 80 * cell.width, height: 24 * cell.height };
  const next = after.map((p) => ({
    key: p.pane,
    rest: restPlace(p, 80, 24, cell, dpr),
    top: p.active,
  }));
  const shown = new Map(
    before.panes.map((p) => [p.pane, restPlace(p, 80, 24, cell, dpr)]),
  );
  const transition = plan({
    now: 0,
    change: { kind: "structural" },
    shown,
    next,
  });
  const moving = new Map<number, Moving>(
    after.map((p) => [
      p.pane,
      { pane: p.pane, box: p, cols: 80, rows: 24, active: p.active },
    ]),
  );

  it("ends on the resting placement exactly: the same rectangles the resting path places", () => {
    const end = transition.at(transition.end, dpr);
    for (const p of after)
      expect(end.get(p.pane)).toEqual(restPlace(p, 80, 24, cell, dpr));
  });

  it("draws, in the last frame before the end, the resting rectangles to the device pixel", () => {
    const { painter, made } = groups();
    // A 60 Hz clock: the last tick before the end.
    let t = 0;
    while (t + 1000 / 60 < PANE_MS.structural) t += 1000 / 60;
    applyMotion(painter, transition, moving, t, dpr, cell, size, "#000", size);
    for (const p of after) {
      const g = made.get(gridOf(p.pane))!;
      const rest = restPlace(p, 80, 24, cell, dpr);
      const d = drawn(g, size);
      expect(d.rect).toEqual(rest.rect);
      // The content laid out at its box: no offset left.
      expect(d.dx).toBe(0);
      expect(d.dy).toBe(0);
    }
  });

  it("moves only transforms and opacity", () => {
    const { painter, made } = groups();
    applyMotion(painter, transition, moving, 40, dpr, cell, size, "#000", size);
    for (const g of made.values())
      for (const el of [g.clipA, g.clipB, g.content]) {
        expect(el.style.left).toBe("");
        expect(el.style.width).toBe("");
      }
  });

  it("maps a click to the cell drawn under it", () => {
    const at = transition.at(40, dpr);
    // Still drawn by pane 1 where pane 2 will be: pane 1's, clamped to its grid.
    const r = at.get(1)!.rect;
    const hit = paneUnder(transition, at, after, r.right - 1, 10, cell);
    expect(hit?.pane.pane).toBe(1);
    expect(hit?.x).toBe(39);
  });
});

describe("content anchors in tmux's panes", () => {
  it("follows a shell's prompt kept at the foot of a pane split below", () => {
    const lines = Array.from({ length: 23 }, (_, i) => `line ${String(i + 1)}`);
    const oldText = [...lines, "$ "];
    const before = viewWith([pane(1, 0, 0, 80, 24)], new Map([[1, oldText]]));
    const shown = shownOf(before, new Map([[1, oldText]]));
    // tmux kept the foot: the last 11 rows.
    const after = viewWith(
      [pane(1, 0, 0, 80, 11), pane(2, 0, 12, 80, 12)],
      new Map([[1, oldText.slice(13)]]),
    );
    const shifts = shiftsOf(shown, after);
    expect(shifts.get(1)).toBe(13);
    const anchor = anchorOf(shifts, cell.height);
    const was: Place = restPlace(before.panes[0], 80, 24, cell, dpr);
    // The new grid starts 13 rows down: its prompt (row 10) where the old
    // prompt (row 23) is.
    const start = anchor(1, was);
    expect(start.y + 10 * cell.height).toBe(was.y + 23 * cell.height);
    const t = plan({
      now: 0,
      change: { kind: "structural" },
      shown: new Map([[1, was]]),
      next: after.panes.map((p) => ({
        key: p.pane,
        rest: restPlace(p, 80, 24, cell, dpr),
      })),
      anchor,
    });
    // The prompt's row on screen, every 4 ms: only ever up, ending at row 10.
    let last = Infinity;
    for (let ms = 0; ms <= PANE_MS.structural; ms += 4) {
      const y = t.at(ms, dpr).get(1)!.y + 10 * cell.height;
      expect(y).toBeLessThanOrEqual(last);
      last = y;
    }
    expect(last).toBe(10 * cell.height);
  });

  it("keeps the rows that leave the grid in the old picture, above it", () => {
    const picture = document.createElement("canvas");
    picture.style.height = `${String(24 * cell.height)}px`;
    const rows = leaving(picture, pane(1, 0, 0, 80, 11), 13, cell);
    expect(rows?.style.top).toBe(`${String(-13 * cell.height)}px`);
    // Only the 13 rows above the new grid's first.
    expect(rows?.style.clipPath).toBe(
      `inset(0 0 ${String(11 * cell.height)}px 0)`,
    );
    expect(leaving(picture, pane(1, 0, 0, 80, 24), 0, cell)).toBeUndefined();
  });
});

describe("a commit", () => {
  const layout = (panes: PaneBox[], window = 1): ControlToPage => ({
    kind: "layout",
    cols: 80,
    rows: 24,
    session: "s",
    windows: [{ id: 1, index: 0, name: "", active: true, zoomed: false }],
    window,
    panes,
    sessionPanes: [],
    client: "c",
    prefixes: [],
  });
  const frame = (
    id: number,
    cols: number,
    rows: number,
    full = false,
  ): ControlToPage => ({
    kind: "pane",
    seq: 1,
    pane: id,
    frame: { cols, rows, full, dirty: [], cursor: undefined, styles: [] },
    modes: { mouse: 0, sgrMouse: false, bracketedPaste: false } as never,
  });

  it("waits for each resized and new pane's picture at its new size", () => {
    const view = viewWith([pane(1, 0, 0, 80, 24)]);
    const held = [layout([pane(1, 0, 0, 40, 24), pane(2, 41, 0, 39, 24)])];
    expect([...waitingFor(view, held, 1)].sort()).toEqual([1, 2]);
    held.push(frame(2, 39, 24));
    expect([...waitingFor(view, held, 1)]).toEqual([1]);
    held.push(frame(1, 80, 24));
    expect([...waitingFor(view, held, 1)]).toEqual([1]);
    held.push(frame(1, 40, 24));
    expect(waitingFor(view, held, 1).size).toBe(0);
  });

  it("after a window switch, waits for whole pictures", () => {
    const view = viewWith([pane(1, 0, 0, 80, 24), pane(5, 0, 0, 80, 24)]);
    view.panes = [view.panes[0]];
    const held = [layout([pane(5, 0, 0, 80, 24)], 2)];
    expect([...waitingFor(view, held, 1)]).toEqual([5]);
    held.push(frame(5, 80, 24, false));
    expect([...waitingFor(view, held, 1)]).toEqual([5]);
    held.push(frame(5, 80, 24, true));
    expect(waitingFor(view, held, 1).size).toBe(0);
  });

  it("says what changed", () => {
    const before = shownOf(
      viewWith([pane(1, 0, 0, 40, 24), pane(2, 41, 0, 39, 24)]),
    );
    const view = viewWith([pane(1, 0, 0, 42, 24), pane(2, 43, 0, 37, 24)]);
    expect(changeOf(before, view)).toEqual({ kind: "step" });
    view.panes = [pane(1, 0, 0, 80, 24)];
    view.windows = [{ id: 1, index: 0, name: "", active: true, zoomed: true }];
    expect(changeOf(before, view)).toEqual({
      kind: "zoom",
      pane: 1,
      zoomIn: true,
    });
    view.windows = [
      { id: 1, index: 0, name: "", active: false, zoomed: false },
      { id: 2, index: 1, name: "", active: true, zoomed: false },
    ];
    view.window = 2;
    expect(changeOf(before, view)).toEqual({ kind: "switch", forward: true });
  });
});
