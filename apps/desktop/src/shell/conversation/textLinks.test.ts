import { describe, expect, it } from "vitest";
import { linkSpans, pathOfHref } from "./textLinks";

/** Each path span as the text it covers, the path it names and where in the file. */
function found(text: string) {
  return linkSpans(text).flatMap((span) =>
    span.kind === "path"
      ? [
          {
            text: text.slice(span.start, span.end),
            path: span.path,
            range: span.range,
          },
        ]
      : [],
  );
}

/** Every span as the text it covers and what it is. */
function spans(text: string) {
  return linkSpans(text).map((span) => {
    const shown = text.slice(span.start, span.end);
    if (span.kind === "path") return { path: shown };
    const where = span.repository;
    return {
      issue: `${where ? `${where.owner}/${where.repository}` : ""}#${span.number}`,
      text: shown,
    };
  });
}

describe("linkSpans: references", () => {
  it("finds a bare #12 and an owner/repo#12", () => {
    expect(spans("Fixes #12, see example/widget#345.")).toEqual([
      { issue: "#12", text: "#12" },
      { issue: "example/widget#345", text: "example/widget#345" },
    ]);
  });

  it("finds one in brackets, after a colon's word, and against CJK text", () => {
    expect(
      spans(
        "(#1) [#2] 「#3」を直しました。これは#4です Merge pull request #5 from x",
      ),
    ).toEqual([
      { issue: "#1", text: "#1" },
      { issue: "#2", text: "#2" },
      { issue: "#3", text: "#3" },
      { issue: "#4", text: "#4" },
      { issue: "#5", text: "#5" },
    ]);
  });

  it("does not take a GitHub line anchor for one: #L12 is the path's line", () => {
    expect(spans("src/a.ts#L12 and #L12 alone")).toEqual([
      { path: "src/a.ts#L12" },
    ]);
  });

  it("leaves URLs alone, a #12 in one included", () => {
    expect(
      spans(
        "https://github.com/example/widget/issues/12 https://example.com/#12 https://example.com/a#12",
      ),
    ).toEqual([]);
  });

  it("does not run one on from a word, an entity or another hash", () => {
    expect(spans("PR#12 a.ts#12 &#12; ##12 #12a #0 #1.5x x@#9")).toEqual([
      // `#1.5x`: the number ends at the full stop.
      { issue: "#1", text: "#1" },
    ]);
  });

  it("leaves a Markdown heading's hashes alone", () => {
    expect(spans("# Title\n## 2. Steps\n### 12")).toEqual([]);
  });

  it("reads a word with a reference in it as the reference, never also as a path", () => {
    expect(spans("example/widget#12 src/a.ts")).toEqual([
      { issue: "example/widget#12", text: "example/widget#12" },
      { path: "src/a.ts" },
    ]);
  });

  it("reads a repository with dots and hyphens, and an owner with hyphens", () => {
    expect(spans("my-org/widget.js#7")).toEqual([
      { issue: "my-org/widget.js#7", text: "my-org/widget.js#7" },
    ]);
  });
});

describe("linkSpans: paths", () => {
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

describe("pathOfHref", () => {
  it("reads a link's target as a file and its position", () => {
    expect(pathOfHref("src/a.ts")).toEqual({
      path: "src/a.ts",
      range: undefined,
    });
    expect(pathOfHref("/abs/a.ts:12")).toEqual({
      path: "/abs/a.ts",
      range: { kind: "line", line: 12, column: 1 },
    });
    expect(pathOfHref("a.ts#L3-L5")).toEqual({
      path: "a.ts",
      range: { kind: "lines", from: 3, to: 5 },
    });
    expect(pathOfHref("file:///abs/my%20file.ts#L2")).toEqual({
      path: "/abs/my file.ts",
      range: { kind: "line", line: 2, column: 1 },
    });
    expect(pathOfHref("README")).toEqual({ path: "README", range: undefined });
  });

  it("leaves a URL and an anchor to the browser", () => {
    expect(pathOfHref("https://example.com/a.ts")).toBeUndefined();
    expect(pathOfHref("mailto:a@example.com")).toBeUndefined();
    expect(pathOfHref("#usage")).toBeUndefined();
    expect(pathOfHref("")).toBeUndefined();
  });
});
