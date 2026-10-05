/**
 * Back and Forward's rules, each against the one method that decides it.
 *
 * Entries are plain strings here: what an entry *is* belongs to the model,
 * and this is the list and the cursor alone.
 */

import { describe, expect, it } from "vitest";
import { NavigationHistory } from "./navigationHistory.js";

const same = (left: string, right: string) => left === right;
const always = () => true;

function history(...visits: string[]): NavigationHistory<string> {
  const [first, ...rest] = visits;
  const made = new NavigationHistory(first, { same });
  for (const visit of rest) made.visit(visit);
  return made;
}

describe("navigation history", () => {
  it("goes back and forward over what was visited", () => {
    const h = history("a", "b", "c");
    expect(h.go("back", always)).toBe("b");
    expect(h.go("back", always)).toBe("a");
    expect(h.go("back", always)).toBeUndefined();
    expect(h.current).toBe("a");
    expect(h.go("forward", always)).toBe("b");
    expect(h.go("forward", always)).toBe("c");
    expect(h.can("forward", always)).toBe(false);
  });

  it("starts with nowhere to go", () => {
    const h = history("a");
    expect(h.can("back", always)).toBe(false);
    expect(h.can("forward", always)).toBe(false);
  });

  it("does not record the move Back itself makes", () => {
    const h = history("a", "b");
    const target = h.go("back", always);
    // The model records every selection, including this one.
    expect(h.visit(target as string)).toBe(false);
    expect(h.list).toEqual(["a", "b"]);
    expect(h.can("forward", always)).toBe(true);
  });

  it("cuts off what was ahead when somewhere new is visited", () => {
    const h = history("a", "b", "c");
    h.go("back", always);
    h.go("back", always);
    h.visit("d");
    expect(h.list).toEqual(["a", "d"]);
    expect(h.can("forward", always)).toBe(false);
  });

  it("keeps the same place twice in a row as one entry", () => {
    const h = history("a", "a", "b", "b");
    expect(h.list).toEqual(["a", "b"]);
  });

  it("replaces the current entry when asked, without touching what is ahead", () => {
    const h = history("a", "b", "c");
    h.go("back", always);
    h.visit("b2", true);
    expect(h.list).toEqual(["a", "b2", "c"]);
    expect(h.go("back", always)).toBe("a");
  });

  it("skips places that have gone, both ways", () => {
    const h = history("a", "gone", "b");
    const exists = (entry: string) => entry !== "gone";
    expect(h.go("back", exists)).toBe("a");
    expect(h.go("forward", exists)).toBe("b");
  });

  it("is disabled when everything behind has gone", () => {
    const h = history("gone", "b");
    const exists = (entry: string) => entry !== "gone";
    expect(h.can("back", exists)).toBe(false);
    expect(h.go("back", exists)).toBeUndefined();
    expect(h.current).toBe("b");
  });

  it("skips a neighbour that is the place already on screen", () => {
    // a, b, a with b closed: Back from the second a must not land on the first.
    const h = history("x", "a", "b", "a");
    const exists = (entry: string) => entry !== "b";
    expect(h.go("back", exists)).toBe("x");
  });

  it("keeps only the newest entries past the limit", () => {
    const h = new NavigationHistory<string>("0", { same, limit: 3 });
    for (const visit of ["1", "2", "3", "4"]) h.visit(visit);
    expect(h.list).toEqual(["2", "3", "4"]);
    expect(h.position).toBe(2);
  });

  it("starts again from a reset", () => {
    const h = history("a", "b");
    h.reset("c");
    expect(h.list).toEqual(["c"]);
    expect(h.can("back", always)).toBe(false);
  });
});
