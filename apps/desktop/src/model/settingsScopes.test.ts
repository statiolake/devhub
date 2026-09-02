import { describe, expect, it } from "vitest";
import { mergeScopes, subtractScope } from "./settingsScopes.js";

describe("mergeScopes", () => {
  it("takes a key only one scope has from that scope", () => {
    expect(mergeScopes({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("lets local win a scalar both scopes spell", () => {
    expect(mergeScopes({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("merges tables key by key rather than replacing them", () => {
    expect(
      mergeScopes(
        { appearance: { terminal_font_size: 12, sidebar_density: "compact" } },
        { appearance: { terminal_font_size: 15 } },
      ),
    ).toEqual({
      appearance: { terminal_font_size: 15, sidebar_density: "compact" },
    });
  });

  it("merges nested tables all the way down", () => {
    expect(
      mergeScopes(
        { appearance: { terminal_theme: { light: { background: "#fff" } } } },
        { appearance: { terminal_theme: { light: { cursor: "#000" } } } },
      ),
    ).toEqual({
      appearance: {
        terminal_theme: { light: { background: "#fff", cursor: "#000" } },
      },
    });
  });

  it("replaces an array whole rather than merging it element by element", () => {
    expect(
      mergeScopes(
        { agent_actions: [{ id: "a" }, { id: "b" }] },
        { agent_actions: [{ id: "c" }] },
      ),
    ).toEqual({ agent_actions: [{ id: "c" }] });
  });

  it("keeps an empty array from local as a real answer", () => {
    expect(
      mergeScopes({ agent_actions: [{ id: "a" }] }, { agent_actions: [] }),
    ).toEqual({ agent_actions: [] });
  });

  it("lets local replace a table with a scalar and the other way round", () => {
    expect(mergeScopes({ a: { b: 1 } }, { a: 2 })).toEqual({ a: 2 });
    expect(mergeScopes({ a: 2 }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it("copies rather than aliasing either scope", () => {
    const global = { appearance: { mode: "auto" } };
    const merged = mergeScopes(global, {}) as {
      appearance: Record<string, unknown>;
    };
    merged.appearance["mode"] = "dark";
    expect(global.appearance.mode).toBe("auto");
  });
});

describe("subtractScope", () => {
  it("drops a key global already spells the same way", () => {
    expect(subtractScope({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: 2 });
  });

  it("keeps a key global spells differently", () => {
    expect(subtractScope({ a: 1 }, { a: 2 })).toEqual({ a: 1 });
  });

  it("keeps every key when there is no global scope at all", () => {
    expect(subtractScope({ a: 1, b: { c: 2 } }, {})).toEqual({
      a: 1,
      b: { c: 2 },
    });
  });

  it("drops a table whose every key global already spells", () => {
    expect(
      subtractScope(
        { appearance: { mode: "auto", terminal_font_size: 12 } },
        { appearance: { mode: "auto", terminal_font_size: 12 } },
      ),
    ).toEqual({});
  });

  it("keeps only the keys of a table that differ", () => {
    expect(
      subtractScope(
        { appearance: { mode: "auto", terminal_font_size: 15 } },
        { appearance: { mode: "auto", terminal_font_size: 12 } },
      ),
    ).toEqual({ appearance: { terminal_font_size: 15 } });
  });

  it("keeps an array whole when any element differs", () => {
    expect(
      subtractScope(
        { agent_actions: [{ id: "a" }, { id: "b" }] },
        { agent_actions: [{ id: "a" }] },
      ),
    ).toEqual({ agent_actions: [{ id: "a" }, { id: "b" }] });
  });

  it("drops an array global already spells element for element", () => {
    expect(
      subtractScope(
        { agent_actions: [{ id: "a", template: "x" }] },
        { agent_actions: [{ id: "a", template: "x" }] },
      ),
    ).toEqual({});
  });

  it("keeps a scalar that global spells as a table", () => {
    expect(subtractScope({ a: 1 }, { a: { b: 1 } })).toEqual({ a: 1 });
  });
});

describe("the two together", () => {
  /**
   * The property the whole arrangement rests on: whatever a save subtracts,
   * merging it back onto global returns exactly the config that was saved.
   */
  const cases: readonly {
    readonly name: string;
    readonly global: Record<string, unknown>;
    readonly desired: Record<string, unknown>;
  }[] = [
    { name: "nothing shared", global: {}, desired: { a: 1, b: { c: 2 } } },
    {
      name: "everything shared",
      global: { a: 1, b: { c: 2 } },
      desired: { a: 1, b: { c: 2 } },
    },
    {
      name: "one nested key differs",
      global: { b: { c: 2, d: 3 } },
      desired: { b: { c: 9, d: 3 } },
    },
    {
      name: "an array differs",
      global: { xs: [{ id: "a" }] },
      desired: { xs: [{ id: "a" }, { id: "b" }] },
    },
    {
      name: "global has a key the save does not touch",
      global: { a: 1, keep: "mine" },
      desired: { a: 2, keep: "mine" },
    },
  ];

  for (const { name, global, desired } of cases) {
    it(`round-trips when ${name}`, () => {
      expect(mergeScopes(global, subtractScope(desired, global))).toEqual(
        desired,
      );
    });
  }
});
