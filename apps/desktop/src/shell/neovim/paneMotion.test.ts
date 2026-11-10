import { describe, expect, it } from "vitest";
import {
  POINT_TO_POINT,
  PANE_MS,
  SLIDE,
  classify,
  cubicBezier,
  plan,
  recede,
  rowShift,
  switchesForward,
  type Place,
} from "./paneMotion";

const place = (
  left: number,
  top: number,
  right: number,
  bottom: number,
  x = left,
  y = top,
): Place => ({ rect: { left, top, right, bottom }, x, y, opacity: 1 });

describe("the curve", () => {
  it("is WinUI's point to point: monotone, no overshoot, ends on 1", () => {
    let last = 0;
    for (let i = 0; i <= 1000; i += 1) {
      const v = POINT_TO_POINT(i / 1000);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
    expect(POINT_TO_POINT(1)).toBe(1);
    // Half way at about 47 ms of 167, 90% at about 77 ms (docs/pane-motion.md).
    expect(POINT_TO_POINT(47 / 167)).toBeCloseTo(0.5, 1);
    expect(POINT_TO_POINT(77 / 167)).toBeCloseTo(0.9, 1);
  });

  it("solves as CSS does", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 5);
  });
});

describe("a transition", () => {
  const shown = new Map([[1, place(0, 0, 800, 600)]]);
  const next = [
    { key: 1, rest: place(0, 0, 404, 600) },
    { key: 2, rest: place(404, 0, 800, 600) },
  ];

  it("ends on the resting layout exactly, whatever the last tick was", () => {
    const t = plan({ now: 1000, change: { kind: "structural" }, shown, next });
    // The last rAF ticks before and after the end.
    for (const dt of [PANE_MS.structural, PANE_MS.structural + 0.4, 400]) {
      const at = t.at(1000 + dt, 2);
      for (const pane of next) expect(at.get(pane.key)).toBe(pane.rest);
    }
    expect(t.done(1000 + PANE_MS.structural)).toBe(true);
    expect(t.done(1000 + PANE_MS.structural - 1)).toBe(false);
  });

  it("starts from what was on screen", () => {
    const t = plan({ now: 0, change: { kind: "structural" }, shown, next });
    expect(t.at(0, 2).get(1)).toEqual(place(0, 0, 800, 600));
    // The new pane is uncovered in place: it never moves.
    for (const ms of [0, 30, 90, 160])
      expect(t.at(ms, 2).get(2)?.rect).toEqual(next[1].rest.rect);
  });

  it("puts every edge on device pixels, the same for panes that share it", () => {
    const t = plan({ now: 0, change: { kind: "structural" }, shown, next });
    for (let ms = 0; ms < PANE_MS.structural; ms += 7) {
      const r = t.at(ms, 2).get(1)!.rect;
      for (const v of [r.left, r.top, r.right, r.bottom])
        expect((v * 2) % 1).toBe(0);
    }
  });

  it("is never past its end", () => {
    const t = plan({ now: 0, change: { kind: "structural" }, shown, next });
    for (let ms = 0; ms <= PANE_MS.structural; ms += 1) {
      const r = t.at(ms, 2).get(1)!.rect;
      expect(r.right).toBeGreaterThanOrEqual(404);
      expect(r.right).toBeLessThanOrEqual(800);
    }
  });

  it("taken over mid-way starts from where it is drawn", () => {
    const first = plan({ now: 0, change: { kind: "structural" }, shown, next });
    const mid = first.at(40, 2);
    // The split undone 40 ms in: pane 2 is gone, pane 1 back to whole.
    const second = plan({
      now: 40,
      change: { kind: "structural" },
      shown: mid,
      next: [{ key: 1, rest: place(0, 0, 800, 600) }],
    });
    expect(second.at(40, 2).get(1)).toEqual(mid.get(1));
    expect(second.at(40, 2).get(2)).toEqual(mid.get(2));
    expect(second.tracks.get(2)?.role).toBe("gone");
    expect(second.at(40 + PANE_MS.structural, 2).get(1)).toEqual(
      place(0, 0, 800, 600),
    );
  });
});

describe("content anchors", () => {
  it("finds how far a shell's lines moved up as its pane got shorter", () => {
    const before = ["$ ls", "a b c", "$ make", "ok", "$ "];
    // Three rows tall now: tmux kept the foot, the prompt.
    const after = ["$ make", "ok", "$ "];
    expect(rowShift(before, after)).toBe(2);
  });

  it("is 0 for a pane that kept its top", () => {
    expect(rowShift(["one", "two", "three", ""], ["one", "two"])).toBe(0);
  });

  it("is 0 when nothing can be matched, or only repeated rows", () => {
    expect(rowShift(["~", "~", "~"], ["~", "~"])).toBe(0);
    expect(rowShift(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("compares over the columns both have", () => {
    // Narrower: the same rows, cut.
    expect(rowShift(["alpha beta", "gamma delta"], ["gamm", "x"])).toBe(1);
  });

  it("moves the content of a pane split below up, with its edge", () => {
    const ch = 20;
    const shown = new Map([[1, place(0, 0, 800, 600)]]);
    // 30 rows to 14: the prompt, at row 29, is at row 13 now.
    const d = 16;
    const rest = place(0, 0, 800, 290);
    const t = plan({
      now: 0,
      change: { kind: "structural" },
      shown,
      next: [
        { key: 1, rest },
        { key: 2, rest: place(0, 290, 800, 600) },
      ],
      anchor: (_key, was) => ({ x: was.x, y: was.y + d * ch }),
    });
    // The prompt's row on screen: the content's origin plus 13 rows.
    const prompt = (ms: number) => t.at(ms, 2).get(1)!.y + 13 * ch;
    expect(prompt(0)).toBe(29 * ch);
    expect(prompt(PANE_MS.structural)).toBe(13 * ch);
    let last = Infinity;
    for (let ms = 0; ms <= PANE_MS.structural; ms += 4) {
      const y = prompt(ms);
      expect(y).toBeLessThanOrEqual(last);
      // Always in its pane's clip: it moves with the edge, not under it.
      expect(y + ch).toBeLessThanOrEqual(t.at(ms, 2).get(1)!.rect.bottom + 1);
      last = y;
    }
  });

  it("slides a pane split to its left with its edge", () => {
    const shown = new Map([[1, place(0, 0, 800, 600)]]);
    const rest = place(396, 0, 800, 600, 400, 0);
    const t = plan({
      now: 0,
      change: { kind: "structural" },
      shown,
      next: [
        { key: 2, rest: place(0, 0, 396, 600) },
        { key: 1, rest },
      ],
    });
    for (let ms = 0; ms <= PANE_MS.structural; ms += 10) {
      const p = t.at(ms, 2).get(1)!;
      // The text travels with the edge: its first column stays between
      // the edge and the half cell the edge ends past it.
      const gap = p.x - p.rect.left;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(4);
    }
    expect(t.at(0, 2).get(1)!.x).toBe(0);
    expect(t.at(PANE_MS.structural, 2).get(1)).toBe(rest);
  });
});

describe("zoom", () => {
  it("pushes the others away from the zoomed pane as it grows", () => {
    const small = { left: 0, top: 0, right: 400, bottom: 600 };
    const large = { left: 0, top: 0, right: 800, bottom: 600 };
    expect(
      recede({ left: 400, top: 0, right: 800, bottom: 600 }, small, large),
    ).toEqual({ dx: 120, dy: 0 });
  });

  it("covers and fades the others, and brings them back on unzoom", () => {
    const shown = new Map([
      [1, place(0, 0, 400, 600)],
      [2, place(400, 0, 800, 600)],
    ]);
    const zoomIn = plan({
      now: 0,
      change: { kind: "zoom", pane: 1, zoomIn: true },
      shown,
      next: [{ key: 1, rest: place(0, 0, 800, 600) }],
      zoomed: 1,
    });
    const gone = zoomIn.tracks.get(2)!;
    expect(gone.role).toBe("gone");
    expect(gone.to.opacity).toBe(0);
    expect(gone.to.rect.left).toBe(520);
    // Not stretched: the other's clip keeps its size.
    expect(gone.to.rect.right - gone.to.rect.left).toBe(400);
    expect(zoomIn.end).toBe(PANE_MS.zoom);
    const unzoom = plan({
      now: 0,
      change: { kind: "zoom", pane: 1, zoomIn: false },
      shown: new Map([[1, place(0, 0, 800, 600)]]),
      next: [
        { key: 1, rest: place(0, 0, 400, 600) },
        { key: 2, rest: place(400, 0, 800, 600) },
      ],
      zoomed: 1,
    });
    const back = unzoom.tracks.get(2)!;
    expect(back.from.opacity).toBe(0);
    expect(back.from.rect.left).toBe(520);
    expect(unzoom.at(PANE_MS.zoom, 2).get(2)).toEqual(place(400, 0, 800, 600));
  });
});

describe("a window switch", () => {
  it("slides the next window in from the right over the last", () => {
    const t = plan({
      now: 0,
      change: { kind: "switch", forward: true },
      shown: new Map([[1, place(0, 0, 800, 600)]]),
      next: [{ key: 7, rest: place(0, 0, 800, 600) }],
    });
    expect(t.at(0, 2).get(7)!.rect.left).toBe(SLIDE.enterOffset);
    expect(t.tracks.get(7)!.layer).toBeGreaterThan(t.tracks.get(1)!.layer);
    expect(t.tracks.get(1)!.to.rect.left).toBe(-SLIDE.exitOffset);
    expect(t.at(SLIDE.enterMs, 2).get(7)).toEqual(place(0, 0, 800, 600));
    expect(t.end).toBe(SLIDE.enterMs);
  });

  it("from the left going back", () => {
    const t = plan({
      now: 0,
      change: { kind: "switch", forward: false },
      shown: new Map([[1, place(0, 0, 800, 600)]]),
      next: [{ key: 7, rest: place(0, 0, 800, 600) }],
    });
    expect(t.at(0, 2).get(7)!.rect.left).toBe(-SLIDE.enterOffset);
  });
});

describe("which side a switch comes from (tabs by their handles)", () => {
  it(":tabnew puts the new tab right of the current one: from the right", () => {
    expect(switchesForward(2, 9, [1, 2, 3], [1, 2, 9, 3])).toBe(true);
  });
  it(":0tabnew and :-tabnew put it left: from the left", () => {
    expect(switchesForward(2, 9, [1, 2, 3], [9, 1, 2, 3])).toBe(false);
    expect(switchesForward(2, 9, [1, 2, 3], [1, 9, 2, 3])).toBe(false);
  });
  it(":tabclose: the tab taking its place comes from its side", () => {
    // Neovim goes to the next tab: it was right of the closed one.
    expect(switchesForward(2, 3, [1, 2, 3], [1, 3])).toBe(true);
    // The last tab closed: the one before it, from the left.
    expect(switchesForward(3, 2, [1, 2, 3], [1, 2])).toBe(false);
  });
  it("gt and gT by the order", () => {
    expect(switchesForward(3, 1, [1, 2, 3], [1, 2, 3])).toBe(false);
    expect(switchesForward(1, 3, [1, 2, 3], [1, 2, 3])).toBe(true);
  });
  it("a moved tab (:tabmove) is judged where it is now", () => {
    expect(switchesForward(1, 2, [1, 2, 3], [2, 1, 3])).toBe(false);
  });
  it("neither order knowing both: forward", () => {
    expect(switchesForward(1, 2, [1], [2])).toBe(true);
  });
});

describe("classify", () => {
  const r = (x: number, width: number) => ({ x, y: 0, width, height: 10 });
  it("says a few cells' move is a step and a split is structural", () => {
    expect(
      classify(
        new Map([
          [1, r(0, 40)],
          [2, r(41, 39)],
        ]),
        new Map([
          [1, r(0, 41)],
          [2, r(42, 38)],
        ]),
      ),
    ).toBe("step");
    expect(
      classify(
        new Map([[1, r(0, 80)]]),
        new Map([
          [1, r(0, 40)],
          [2, r(41, 39)],
        ]),
      ),
    ).toBe("structural");
    expect(
      classify(
        new Map([
          [1, r(0, 40)],
          [2, r(41, 39)],
        ]),
        new Map([
          [1, r(0, 60)],
          [2, r(61, 19)],
        ]),
      ),
    ).toBe("structural");
    expect(classify(new Map([[1, r(0, 40)]]), new Map([[1, r(0, 40)]]))).toBe(
      "same",
    );
  });
});
