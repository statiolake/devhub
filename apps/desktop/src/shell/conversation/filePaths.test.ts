import { describe, expect, it } from "vitest";
import { pathSpans } from "./filePaths";

/** Each span as the text it covers, the path it names and where in the file. */
function found(text: string) {
  return pathSpans(text).map((span) => ({
    text: text.slice(span.start, span.end),
    path: span.path,
    range: span.range,
  }));
}

describe("pathSpans", () => {
  it("finds absolute, home and relative paths", () => {
    expect(
      found("See /work/app/src/main.ts, ~/notes/todo.md and src/b.ts."),
    ).toEqual([
      {
        text: "/work/app/src/main.ts",
        path: "/work/app/src/main.ts",
        range: undefined,
      },
      { text: "~/notes/todo.md", path: "~/notes/todo.md", range: undefined },
      // The full stop is the sentence's.
      { text: "src/b.ts", path: "src/b.ts", range: undefined },
    ]);
  });

  it("reads a line, a line and column, and a range of lines", () => {
    expect(found("a.ts:12 b.ts:12:5 c.ts:12-20")).toEqual([
      {
        text: "a.ts:12",
        path: "a.ts",
        range: { kind: "line", line: 12, column: 1 },
      },
      {
        text: "b.ts:12:5",
        path: "b.ts",
        range: { kind: "line", line: 12, column: 5 },
      },
      {
        text: "c.ts:12-20",
        path: "c.ts",
        range: { kind: "lines", from: 12, to: 20 },
      },
    ]);
  });

  it("reads GitHub's #L12 and #L12-L20", () => {
    expect(found("src/a.ts#L12 src/b.ts#L12-L20")).toEqual([
      {
        text: "src/a.ts#L12",
        path: "src/a.ts",
        range: { kind: "line", line: 12, column: 1 },
      },
      {
        text: "src/b.ts#L12-L20",
        path: "src/b.ts",
        range: { kind: "lines", from: 12, to: 20 },
      },
    ]);
  });

  it("links grep's path:line and leaves the matched text out", () => {
    const text = "src/a.ts:3:const a = 1;\nsrc/b.ts:14:  return b;";
    expect(found(text).map((span) => span.text)).toEqual([
      "src/a.ts:3",
      "src/b.ts:14",
    ]);
  });

  it("is ended by quotes, brackets, backticks and CJK punctuation", () => {
    expect(
      found(
        '("src/a.ts") [src/b.ts] `src/c.ts` 「src/d.ts」を読みました、src/e.ts。',
      ).map((span) => span.path),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
  });

  it("does not take a path with a space in it for one", () => {
    // A path is one word: this is two, and neither is the file.
    expect(found("/work/my notes/a.md").map((span) => span.path)).toEqual([
      "/work/my",
      "notes/a.md",
    ]);
  });

  it("leaves URLs, flags, bare words and folders alone", () => {
    expect(
      found("https://example.com/a/b.ts --out=dist Note: // and 1.5 then src/"),
    ).toEqual([]);
  });

  it("takes a bare file name with an extension as a relative path", () => {
    expect(found("Edit README.md and .gitignore").map((s) => s.path)).toEqual([
      "README.md",
    ]);
  });

  it("ignores a line of 0 and a range that runs backwards as ranges", () => {
    expect(found("a.ts:0 b.ts:20-12")).toEqual([
      { text: "a.ts", path: "a.ts", range: undefined },
      {
        text: "b.ts:20-12",
        path: "b.ts",
        range: { kind: "line", line: 20, column: 1 },
      },
    ]);
  });
});
