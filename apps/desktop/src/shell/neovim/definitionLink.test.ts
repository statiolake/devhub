import { describe, expect, it } from "vitest";
import {
  DefinitionLinks,
  inSpans,
  isModifierKey,
  linkAnswerOf,
  linkAttr,
  linkCells,
  modifierHeld,
  type Link,
  type LinkCell,
} from "./definitionLink";

/** A frame clock the test turns. */
function frames() {
  let queued: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      queued.push(fn);
    },
    frame: () => {
      const run = queued;
      queued = [];
      for (const fn of run) fn();
    },
  };
}

/** Neovim's side: each ask answered by the test. */
function harness() {
  const clock = frames();
  const asks: { seq: number; at: LinkCell; reply: (v: unknown) => void }[] = [];
  const jumps: LinkCell[] = [];
  const shown: (Link | undefined)[] = [];
  let cancels = 0;
  const links = new DefinitionLinks(
    {
      hover: (seq, at) =>
        new Promise((resolve) => {
          asks.push({ seq, at, reply: resolve });
        }),
      jump: (at) => jumps.push(at),
      cancel: () => {
        cancels += 1;
      },
      changed: (link) => shown.push(link),
    },
    clock.schedule,
  );
  return {
    links,
    clock,
    asks,
    jumps,
    shown,
    get cancels() {
      return cancels;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const ALPHA = [{ row: 1, col0: 6, col1: 10 }];
const at = (col: number, row = 1): LinkCell => ({ grid: 2, row, col });

describe("the modifier", () => {
  it("is the one key named, alone", () => {
    const none = {
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
    };
    expect(modifierHeld({ ...none, altKey: true }, "alt")).toBe(true);
    expect(modifierHeld({ ...none, altKey: true, shiftKey: true }, "alt")).toBe(
      false,
    );
    expect(modifierHeld({ ...none, altKey: true, metaKey: true }, "alt")).toBe(
      false,
    );
    expect(modifierHeld({ ...none, metaKey: true }, "cmd")).toBe(true);
    expect(modifierHeld({ ...none, metaKey: true }, "alt")).toBe(false);
    expect(modifierHeld({ ...none, ctrlKey: true }, "ctrl")).toBe(true);
    expect(modifierHeld({ ...none, altKey: true }, "off")).toBe(false);
    expect(isModifierKey("Alt", "alt")).toBe(true);
    expect(isModifierKey("Meta", "cmd")).toBe(true);
    expect(isModifierKey("Control", "ctrl")).toBe(true);
    expect(isModifierKey("Alt", "cmd")).toBe(false);
    expect(isModifierKey("Alt", "off")).toBe(false);
  });
});

describe("Neovim's answers", () => {
  it("are read strictly", () => {
    expect(linkAnswerOf(false)).toBe(false);
    expect(linkAnswerOf(null)).toBe(false);
    expect(linkAnswerOf({ spans: [] })).toBe(false);
    expect(
      linkAnswerOf({
        seq: 3,
        link: true,
        spans: [
          { row: 1, col0: 6, col1: 10 },
          { row: 2, col0: 4, col1: 1 },
          "x",
        ],
      }),
    ).toEqual({ seq: 3, link: true, spans: ALPHA });
    expect(inSpans(2, ALPHA, at(6))).toBe(true);
    expect(inSpans(2, ALPHA, at(11))).toBe(false);
    expect(inSpans(3, ALPHA, { grid: 3, row: 1, col: 6 })).toBe(true);
    expect(inSpans(2, ALPHA, { grid: 3, row: 1, col: 6 })).toBe(false);
  });
});

describe("the link while the modifier is held", () => {
  it("asks nothing while the modifier is up", () => {
    const h = harness();
    for (let col = 0; col < 20; col += 1) h.links.pointerAt(at(col), false);
    h.clock.frame();
    expect(h.asks).toEqual([]);
  });

  it("asks on the modifier going down, and draws the link Neovim answers", async () => {
    const h = harness();
    h.links.pointerAt(at(7), false);
    h.links.modifier(true);
    expect(h.asks.map((a) => a.at)).toEqual([at(7)]);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, pending: true });
    await flush();
    expect(h.links.link).toBeUndefined();
    // The answer comes as the definition_link event.
    h.links.answer({ seq: 1, spans: ALPHA, link: true });
    expect(h.links.link).toEqual({ grid: 2, spans: ALPHA });
    expect(h.shown).toEqual([{ grid: 2, spans: ALPHA }]);
    expect(h.links.overLink).toBe(true);
  });

  it("is gone the moment the modifier goes up, the request cancelled", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, link: true });
    await flush();
    expect(h.links.link).toBeDefined();
    h.links.modifier(false);
    // Synchronously: the editor paints in the keyup's own frame.
    expect(h.links.link).toBeUndefined();
    expect(h.shown.at(-1)).toBeUndefined();
    // A pending ask, then the modifier up: Neovim drops its request.
    h.clock.frame();
    h.links.modifier(true);
    h.links.modifier(false);
    expect(h.cancels).toBe(1);
  });

  it("does not ask again over the same symbol, and asks one a frame", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, link: true });
    await flush();
    for (const col of [8, 9, 10, 6]) h.links.pointerAt(at(col), true);
    h.clock.frame();
    expect(h.asks).toHaveLength(1);
    expect(h.links.link).toBeDefined();
    // Off the word: the link goes at once, the next ask is now, and the
    // moves of that frame make a single ask more, the newest.
    h.links.pointerAt(at(12), true);
    expect(h.links.link).toBeUndefined();
    h.links.pointerAt(at(13), true);
    h.links.pointerAt(at(14), true);
    expect(h.asks.map((a) => a.at.col)).toEqual([7, 12]);
    h.clock.frame();
    expect(h.asks.map((a) => a.at.col)).toEqual([7, 12, 14]);
  });

  it("drops a stale answer", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.clock.frame();
    h.links.pointerAt(at(2), true);
    // The answer for the first ask comes after the second was made.
    h.links.answer({ seq: 1, spans: ALPHA, link: true });
    expect(h.links.link).toBeUndefined();
    h.links.answer({
      seq: 2,
      spans: [{ row: 1, col0: 0, col1: 4 }],
      link: false,
    });
    expect(h.links.link).toBeUndefined();
    expect(h.shown).toEqual([]);
  });

  it("is not drawn for an answer after the modifier went up", () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.links.modifier(false);
    h.links.answer({ seq: 1, spans: ALPHA, link: true });
    expect(h.links.link).toBeUndefined();
  });

  it("goes when the pointer leaves the windows", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, link: true });
    await flush();
    h.links.pointerAt(undefined, true);
    expect(h.links.link).toBeUndefined();
  });

  it("is asked again when what it was drawn over changed", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, link: true });
    await flush();
    h.clock.frame();
    h.links.invalidate();
    expect(h.links.link).toBeUndefined();
    expect(h.asks).toHaveLength(2);
  });
});

describe("the modifier's click", () => {
  it("on the link is the jump, not a click", async () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    h.asks[0]?.reply({ seq: 1, spans: ALPHA, link: true });
    await flush();
    expect(h.links.click(at(9), true)).toBe(true);
    expect(h.jumps).toEqual([at(9)]);
    expect(h.links.link).toBeUndefined();
  });

  it("on a symbol whose answer is coming is the jump too", () => {
    const h = harness();
    h.links.pointerAt(at(7), true);
    expect(h.links.click(at(7), true)).toBe(true);
    expect(h.jumps).toEqual([at(7)]);
  });

  it("is Neovim's where there is no definition, no word, or no modifier", async () => {
    const h = harness();
    h.links.pointerAt(at(2), true);
    h.asks[0]?.reply({
      seq: 1,
      spans: [{ row: 1, col0: 0, col1: 4 }],
      link: false,
    });
    await flush();
    expect(h.links.click(at(2), true)).toBe(false);
    h.links.pointerAt(at(5), true);
    h.clock.frame();
    h.asks[1]?.reply(false);
    await flush();
    expect(h.links.click(at(5), true)).toBe(false);
    // A link drawn, then a click without the modifier: an ordinary click.
    h.links.pointerAt(at(7), true);
    h.clock.frame();
    h.asks.at(-1)?.reply({ seq: h.asks.at(-1)?.seq, spans: ALPHA, link: true });
    await flush();
    expect(h.links.link).toBeDefined();
    expect(h.links.click(at(7), false)).toBe(false);
    expect(h.jumps).toEqual([]);
  });
});

describe("the link as drawn", () => {
  it("covers exactly its spans' cells, clipped to the grid", () => {
    expect(linkCells(10, 3, [{ row: 1, col0: 2, col1: 4 }])).toEqual([
      12, 13, 14,
    ]);
    // A wrapped symbol: the end of one row and the start of the next.
    expect(
      linkCells(10, 3, [
        { row: 0, col0: 8, col1: 9 },
        { row: 1, col0: 0, col1: 1 },
      ]),
    ).toEqual([8, 9, 10, 11]);
    expect(linkCells(10, 3, [{ row: 5, col0: 0, col1: 1 }])).toEqual([]);
    expect(linkCells(10, 3, [{ row: 2, col0: 8, col1: 12 }])).toEqual([28, 29]);
  });

  it("is each cell's own colours with the link's ink, underlined", () => {
    const own = {
      foreground: 0x111111,
      background: 0x222222,
      bold: true,
      undercurl: true,
      reverse: true,
    };
    expect(linkAttr(own, 0x3794ff)).toMatchObject({
      background: 0x222222,
      bold: true,
      foreground: 0x3794ff,
      special: 0x3794ff,
      underline: true,
      undercurl: false,
      reverse: false,
    });
  });
});
