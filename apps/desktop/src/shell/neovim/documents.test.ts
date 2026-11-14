import { describe, expect, it } from "vitest";
import { NO_LAYERS, applyLayerEvent, LAYER_EVENTS } from "./layers";
import {
  headingSlug,
  lineAtPixel,
  lineAtPixelExact,
  lineMarks,
  pixelOfLine,
  scrolledTop,
  sourcePlace,
} from "./documents";

describe("gui.document's events", () => {
  it("keeps a document's text, where it is, and what its keys asked", () => {
    for (const kind of [
      "document",
      "document_clear",
      "documents",
      "document_scroll",
      "document_activate",
    ])
      expect(LAYER_EVENTS.has(kind)).toBe(true);
    let state = applyLayerEvent(NO_LAYERS, "document", {
      id: 4,
      format: "markdown",
      text: "# A\n\nb",
      base: "/notes",
      title: "a.md",
    });
    expect(state.documents.get(4)).toEqual({
      id: 4,
      format: "markdown",
      text: "# A\n\nb",
      base: "/notes",
      remoteImages: false,
      title: "a.md",
    });
    state = applyLayerEvent(state, "documents", {
      documents: [
        {
          id: 4,
          win: 1001,
          topline: 12,
          current: true,
          focus: { line: 3, href: "b.md" },
        },
        { id: 5, win: "no" },
      ],
    });
    expect(state.placedDocuments).toEqual([
      {
        id: 4,
        win: 1001,
        topline: 12,
        current: true,
        told: false,
        focus: { line: 3, href: "b.md" },
      },
    ]);
    state = applyLayerEvent(state, "document_scroll", {
      id: 4,
      seq: 7,
      by: "to",
      n: 1,
      line: 30,
    });
    expect(state.documentScrolls.get(4)).toEqual({
      seq: 7,
      by: "to",
      n: 1,
      line: 30,
    });
    // A scroll of no kind the page knows is no scroll.
    expect(
      applyLayerEvent(state, "document_scroll", { id: 4, seq: 8, by: "far" }),
    ).toBe(state);
    state = applyLayerEvent(state, "document_activate", {
      id: 4,
      seq: 9,
      line: 3,
      href: "b.md",
    });
    expect(state.documentActivations.get(4)).toEqual({
      seq: 9,
      line: 3,
      href: "b.md",
    });
    state = applyLayerEvent(state, "document_clear", { id: 4 });
    expect(state.documents.size).toBe(0);
    expect(state.placedDocuments).toEqual([]);
    expect(state.documentScrolls.size).toBe(0);
  });
});

describe("a source line as a height in the drawing", () => {
  // # Title (line 1, 0px), a paragraph (3, 40px), a code block of lines
  // 5–14 (5, 100px), a paragraph after it (16, 400px); 500px in all.
  const marks = lineMarks([
    { line: 1, top: 0 },
    { line: 3, top: 40 },
    { line: 5, top: 100 },
    { line: 16, top: 400 },
    // a list item inside the paragraph's block, on its line: the block's
    { line: 3, top: 44 },
  ]);

  it("is the top of the block a line starts, interpolated within it", () => {
    expect(marks).toEqual([
      { line: 1, top: 0 },
      { line: 3, top: 40 },
      { line: 5, top: 100 },
      { line: 16, top: 400 },
    ]);
    expect(pixelOfLine(marks, 1, 500, 20)).toBe(0);
    expect(pixelOfLine(marks, 2, 500, 20)).toBe(20);
    expect(pixelOfLine(marks, 5, 500, 20)).toBe(100);
    // half way through the code block's lines, half way down its height
    expect(pixelOfLine(marks, 10.5, 500, 20)).toBeCloseTo(250);
    // the last block runs to the drawing's end
    expect(pixelOfLine(marks, 18, 500, 20)).toBe(440);
  });

  it("goes back from a height to the line drawn there", () => {
    expect(lineAtPixel(marks, 0, 500, 20)).toBe(1);
    expect(lineAtPixel(marks, 39, 500, 20)).toBe(2);
    expect(lineAtPixel(marks, 250, 500, 20)).toBe(10);
    expect(lineAtPixelExact(marks, 250, 500, 20)).toBeCloseTo(10.5);
    expect(lineAtPixel(marks, 499, 500, 20)).toBe(20);
    for (const line of [1, 3, 5, 9, 16])
      expect(
        lineAtPixel(marks, pixelOfLine(marks, line, 500, 20), 500, 20),
      ).toBe(line);
  });

  it("scrolls by what the keys asked, within the drawing", () => {
    const pixel = (line: number) => pixelOfLine(marks, line, 500, 20);
    const by = (scroll: Parameters<typeof scrolledTop>[0], top: number) =>
      scrolledTop(scroll, top, 200, 300, 24, pixel);
    expect(by({ seq: 1, by: "line", n: 2, line: undefined }, 0)).toBe(144);
    expect(by({ seq: 1, by: "half", n: -1, line: undefined }, 50)).toBe(0);
    expect(by({ seq: 1, by: "page", n: 1, line: undefined }, 0)).toBe(152);
    expect(by({ seq: 1, by: "bottom", n: 1, line: undefined }, 0)).toBe(300);
    expect(by({ seq: 1, by: "top", n: 1, line: undefined }, 90)).toBe(0);
    expect(by({ seq: 1, by: "to", n: 1, line: 5 }, 0)).toBe(100);
    // never past the end
    expect(by({ seq: 1, by: "to", n: 1, line: 18 }, 0)).toBe(300);
  });
});

describe("a heading's anchor", () => {
  it("is GitHub's: lower case, no punctuation, hyphens, numbered again", () => {
    const seen = new Map<string, number>();
    expect(headingSlug("Getting Started!", seen)).toBe("getting-started");
    expect(headingSlug("API: v2.0 (beta)", seen)).toBe("api-v20-beta");
    expect(headingSlug("日本語の見出し", seen)).toBe("日本語の見出し");
    expect(headingSlug("Getting Started", seen)).toBe("getting-started-1");
  });

  it("finds a point of the drawing in the source: a word in prose, a column in code", () => {
    const lines = [
      "# Title", // 1
      "", // 2
      "Some **bold** text and a [link](x.md) to", // 3
      "the second line of it, and text again.", // 4
      "", // 5
      "  ```ts", // 6
      "  const x = 1;", // 7
      "  let y = x;", // 8
      "  ```", // 9
    ];
    // "text" the second time: on the paragraph's second line.
    const drawn = "Some bold text and a link to the second line of it, and te";
    expect(sourcePlace(lines, 3, drawn, "xt again.", false)).toEqual({
      line: 4,
      col: lines[3]!.indexOf("text again") + 2,
    });
    // Its first word, past markup.
    expect(sourcePlace(lines, 3, "Some bo", "ld text", false)).toEqual({
      line: 3,
      col: lines[2]!.indexOf("bold") + 2,
    });
    // Between words: the word after the point.
    expect(sourcePlace(lines, 3, "Some ", "bold", false)).toEqual({
      line: 3,
      col: lines[2]!.indexOf("bold"),
    });
    // Nothing to go by: the block's line.
    expect(
      sourcePlace(lines, 3, "Some bold text and a link to ", "", false),
    ).toEqual({
      line: 3,
      col: undefined,
    });
    // Code: past the fence, lines as drawn, its indent kept.
    expect(sourcePlace(lines, 6, "const x = 1;\nlet ", "y = x;", true)).toEqual(
      {
        line: 8,
        col: 6,
      },
    );
  });
});
