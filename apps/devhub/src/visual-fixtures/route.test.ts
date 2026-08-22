import { describe, expect, it } from "vitest";
import { fixtureSnapshots, parseFixtureQuery } from "./route";

describe("development visual fixture route", () => {
  it("keeps the native shell for an absent fixture query", () => {
    expect(parseFixtureQuery("")).toBeUndefined();
  });

  it("accepts only the exact supported fixture names", () => {
    expect(parseFixtureQuery("?fixture=global")).toBe("global");
    expect(parseFixtureQuery("?fixture=closing-failed")).toBe("closing-failed");
    expect(parseFixtureQuery("?fixture=GLOBAL")).toBeUndefined();
    expect(parseFixtureQuery("?fixture=global&fixture=agent")).toBeUndefined();
  });

  it("falls back to the native shell for invalid values", () => {
    expect(parseFixtureQuery("?fixture=not-a-fixture")).toBeUndefined();
    expect(fixtureSnapshots.global.selection.context).toEqual({
      kind: "global",
    });
  });
});
