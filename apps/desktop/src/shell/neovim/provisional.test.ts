import { describe, expect, it } from "vitest";
import { Provisional } from "./provisional";

type At = { readonly row: number; readonly col: number };
const same = (a: At, b: At) => a.row === b.row && a.col === b.col;
const at = (row: number, col: number): At => ({ row, col });

describe("what the pointer did, before Neovim says so", () => {
  it("shows the guess while Neovim still shows where it was", () => {
    const p = new Provisional(same);
    p.predict(at(5, 7), at(1, 0), 0, 600);
    expect(p.shown(at(1, 0), 10)).toEqual(at(5, 7));
    expect(p.pending).toBe(true);
  });

  it("is Neovim's, unseen, once Neovim agrees", () => {
    const p = new Provisional(same);
    p.predict(at(5, 7), at(1, 0), 0, 600);
    expect(p.shown(at(5, 7), 20)).toEqual(at(5, 7));
    expect(p.pending).toBe(false);
    // Later moves are Neovim's alone.
    expect(p.shown(at(6, 0), 30)).toEqual(at(6, 0));
  });

  it("gives way at once when Neovim decided otherwise: Neovim wins", () => {
    const p = new Provisional(same);
    p.predict(at(5, 7), at(1, 0), 0, 600);
    expect(p.shown(at(5, 3), 20)).toEqual(at(5, 3));
    expect(p.pending).toBe(false);
    // And it does not come back when Neovim moves through the base again.
    expect(p.shown(at(1, 0), 30)).toEqual(at(1, 0));
  });

  it("is taken back when Neovim never moved", () => {
    const p = new Provisional(same);
    p.predict(at(5, 7), at(1, 0), 0, 600);
    expect(p.shown(at(1, 0), 599)).toEqual(at(5, 7));
    expect(p.shown(at(1, 0), 601)).toEqual(at(1, 0));
    expect(p.pending).toBe(false);
  });

  it("makes no guess where Neovim already is", () => {
    const p = new Provisional(same);
    p.predict(at(1, 0), at(1, 0), 0, 600);
    expect(p.pending).toBe(false);
  });

  it("follows a drag without going back to a cell Neovim is still on its way through", () => {
    const p = new Provisional(same);
    p.predict(at(5, 1), at(5, 0), 0, 600);
    p.predict(at(5, 2), at(5, 0), 5, 600);
    p.predict(at(5, 3), at(5, 0), 10, 600);
    // Neovim answers the first move, then the second: the caret stays at
    // the newest cell, never jumping back to them.
    expect(p.shown(at(5, 1), 20)).toEqual(at(5, 3));
    expect(p.shown(at(5, 2), 25)).toEqual(at(5, 3));
    expect(p.shown(at(5, 3), 30)).toEqual(at(5, 3));
    expect(p.pending).toBe(false);
  });

  it("still gives way to a cell the drag never went over", () => {
    const p = new Provisional(same);
    p.predict(at(5, 1), at(5, 0), 0, 600);
    p.predict(at(5, 2), at(5, 0), 5, 600);
    expect(p.shown(at(4, 9), 20)).toEqual(at(4, 9));
  });
});
