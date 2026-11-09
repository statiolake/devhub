import { describe, expect, it } from "vitest";
import { pasteBytes, sgrMouse, tmuxKey, type KeyLike } from "./controlKeys";
import {
  applyControl,
  borders,
  hlOf,
  newControlView,
  paneAt,
  paneBoxes,
  paneOutlines,
  paneReach,
  plainBorders,
} from "./paneGrids";

const key = (k: string, code = "", mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("keys by tmux's names", () => {
  it("names characters, named keys and their modifiers", () => {
    expect(tmuxKey(key("a", "KeyA"), false)).toBe("a");
    expect(tmuxKey(key(";", "Semicolon"), false)).toBe(";");
    expect(tmuxKey(key(" ", "Space"), false)).toBe("Space");
    expect(tmuxKey(key("q", "KeyQ", { ctrlKey: true }), false)).toBe("C-q");
    expect(
      tmuxKey(key("Q", "KeyQ", { ctrlKey: true, shiftKey: true }), false),
    ).toBe("C-q");
    expect(tmuxKey(key("Enter"), false)).toBe("Enter");
    expect(tmuxKey(key("Backspace"), false)).toBe("BSpace");
    expect(tmuxKey(key("Tab", "Tab", { shiftKey: true }), false)).toBe("BTab");
    expect(tmuxKey(key("ArrowUp", "ArrowUp", { shiftKey: true }), false)).toBe(
      "S-Up",
    );
    expect(tmuxKey(key("PageDown"), false)).toBe("NPage");
    expect(tmuxKey(key("F5"), false)).toBe("F5");
  });

  it("makes Option Meta only when it is, by the physical key", () => {
    expect(tmuxKey(key("≈", "KeyX", { altKey: true }), true)).toBe("M-x");
    expect(tmuxKey(key("≈", "KeyX", { altKey: true }), false)).toBe("≈");
    expect(tmuxKey(key("ArrowUp", "ArrowUp", { altKey: true }), true)).toBe(
      "M-Up",
    );
  });

  it("leaves Cmd chords, bare modifiers and an IME's keys alone", () => {
    expect(tmuxKey(key("v", "KeyV", { metaKey: true }), false)).toBeUndefined();
    expect(tmuxKey(key("Shift", "ShiftLeft"), false)).toBeUndefined();
    expect(tmuxKey(key("Process"), false)).toBeUndefined();
  });

  it("brackets a paste for a program that asked, and reports the mouse in SGR", () => {
    expect(dec(pasteBytes("a\nb", true))).toBe("\x1b[200~a\rb\x1b[201~");
    expect(dec(pasteBytes("a\r\nb", false))).toBe("a\rb");
    expect(dec(sgrMouse(0, 4, 2, false))).toBe("\x1b[<0;5;3M");
    expect(dec(sgrMouse(64, 0, 0, true))).toBe("\x1b[<64;1;1m");
  });
});

describe("panes as the painter's grids", () => {
  const layout = {
    kind: "layout" as const,
    cols: 21,
    rows: 5,
    session: "s",
    windows: [{ id: 0, index: 1, name: "zsh", active: true, zoomed: false }],
    window: 0,
    panes: [
      {
        pane: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 5,
        active: true,
        synchronized: false,
      },
      {
        pane: 2,
        x: 11,
        y: 0,
        width: 10,
        height: 2,
        active: false,
        synchronized: false,
      },
      {
        pane: 3,
        x: 11,
        y: 3,
        width: 10,
        height: 2,
        active: false,
        synchronized: false,
      },
    ],
    sessionPanes: [1, 2, 3].map((pane) => ({
      pane,
      window: 0,
      inMode: false,
      socket: "",
    })),
    client: "client-1",
    prefixes: ["C-q"],
  };

  it("places each pane's grid at its rectangle, and finds the pane under a cell", () => {
    const view = newControlView({ foreground: 0xffffff, background: 0 });
    applyControl(view, layout);
    for (const pane of [1, 2, 3]) {
      applyControl(view, {
        kind: "pane",
        seq: pane,
        pane,
        modes: {
          mouse: 0,
          sgrMouse: false,
          bracketedPaste: false,
          focusEvents: false,
          alternateScreen: false,
        },
        frame: {
          cols: 10,
          rows: pane === 1 ? 5 : 2,
          full: true,
          dirty: [
            {
              y: 0,
              cells: ["h", "i", ...Array<string>(8).fill(" ")],
              styles: new Uint32Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
            },
          ],
          cursor: { x: 2, y: 0, visible: true, blinking: false, shape: 1 },
          styles: [[1, { fg: 0xff0000, bold: true }]],
        },
      });
    }
    expect(
      paneBoxes(view).map((b) => [b.col, b.row, b.width, b.height]),
    ).toEqual([
      [0, 0, 10, 5],
      [11, 0, 10, 2],
      [11, 3, 10, 2],
    ]);
    // Each pane's style 1 is its own highlight.
    const grid2 = view.state.grids.get(4);
    const grid1 = view.state.grids.get(3);
    expect(grid1?.chars.slice(0, 2)).toEqual(["h", "i"]);
    expect(grid1?.hls[0]).not.toBe(grid2?.hls[0]);
    expect(view.state.hl.get(grid1?.hls[0] ?? 0)).toEqual({
      foreground: 0xff0000,
      bold: true,
    });
    expect(paneAt(view, 12, 4)?.pane).toBe(3);
    expect(paneAt(view, 10, 1)).toBeUndefined();
  });

  it("draws a hairline in each gap tmux leaves between panes, joined where they meet", () => {
    // A T: the line under the right two panes starts on the one beside them.
    expect(borders(layout.panes)).toEqual([
      { vertical: true, x: 10, y: 0, length: 5 },
      { vertical: false, x: 10.5, y: 2, length: 10.5 },
    ]);
  });

  it("crosses where four panes meet", () => {
    const box = (pane: number, x: number, y: number) => ({
      pane,
      x,
      y,
      width: 4,
      height: 3,
      active: false,
      synchronized: false,
    });
    expect(
      borders([box(1, 0, 0), box(2, 5, 0), box(3, 0, 4), box(4, 5, 4)]),
    ).toEqual([
      { vertical: true, x: 4, y: 0, length: 7 },
      { vertical: false, x: 0, y: 3, length: 9 },
    ]);
  });

  it("draws nothing for one pane", () => {
    expect(borders([layout.panes[0]])).toEqual([]);
  });

  it("outlines the active pane on its separators, which are not drawn again under it", () => {
    const outlines = paneOutlines(layout.panes);
    // The pane on the left: its one side with a gap, down the whole window.
    expect(outlines).toEqual([
      { vertical: true, x: 10, y: 0, length: 5, active: true },
    ]);
    expect(plainBorders(borders(layout.panes), outlines)).toEqual([
      { vertical: false, x: 10.5, y: 2, length: 10.5 },
    ]);
    expect(paneOutlines([layout.panes[0]])).toEqual([]);
  });

  it("reaches the middle of a + from the active pane's corner, the rest of the cross plain", () => {
    const box = (pane: number, x: number, y: number) => ({
      pane,
      x,
      y,
      width: 4,
      height: 3,
      active: pane === 1,
      synchronized: false,
    });
    const panes = [box(1, 0, 0), box(2, 5, 0), box(3, 0, 4), box(4, 5, 4)];
    const outlines = paneOutlines(panes);
    expect(outlines).toEqual([
      { vertical: true, x: 4, y: 0, length: 3.5, active: true },
      { vertical: false, x: 0, y: 3, length: 4.5, active: true },
    ]);
    expect(plainBorders(borders(panes), outlines)).toEqual([
      { vertical: true, x: 4, y: 3.5, length: 3.5 },
      { vertical: false, x: 4.5, y: 3, length: 4.5 },
    ]);
  });

  it("lets what is over a pane reach the near edge of the line beside it", () => {
    // A Retina cell, 8.25 × 16.5: the lines on whole pixels.
    const cell = { width: 8.25, height: 16.5 };
    const outlines = paneOutlines(layout.panes);
    const [left, upper] = layout.panes;
    // The active pane's side is its 2px outline, from 86 to 88 about the
    // border cell's middle at 86.625.
    expect(paneReach(left!, layout.panes, outlines, cell)).toEqual({
      left: 0,
      top: 0,
      right: 86 - 82.5,
      bottom: 0,
    });
    // Beside it the outline too; under it a 1px hairline from 41 to 42.
    expect(paneReach(upper!, layout.panes, outlines, cell)).toEqual({
      left: 90.75 - 88,
      top: 0,
      right: 0,
      bottom: 41 - 33,
    });
  });

  it("outlines every synchronized pane, the active one last", () => {
    const synced = layout.panes.map((p) => ({ ...p, synchronized: true }));
    const outlines = paneOutlines(synced);
    expect(
      outlines.map((o) => [o.vertical, o.x, o.y, o.length, o.active]),
    ).toEqual([
      [true, 10, 0, 2.5, false],
      [false, 10.5, 2, 10.5, false],
      [true, 10, 2.5, 2.5, false],
      [false, 10.5, 2, 10.5, false],
      [true, 10, 0, 5, true],
    ]);
    expect(plainBorders(borders(synced), outlines)).toEqual([]);
  });

  it("draws faint ink half way to its ground and hidden ink as the ground", () => {
    const defaults = { foreground: 0xffffff, background: 0x000000 };
    expect(hlOf({ faint: true }, defaults).foreground).toBe(0x808080);
    expect(hlOf({ invisible: true, bg: 0x123456 }, defaults).foreground).toBe(
      0x123456,
    );
    expect(hlOf({ underline: 3 }, defaults)).toEqual({ undercurl: true });
  });
});
