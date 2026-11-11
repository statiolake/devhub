import { describe, expect, it } from "vitest";
import {
  extendTo,
  gridRows,
  lineAt,
  routeMouse,
  selectedText,
  selectionSpans,
  wordAt,
  type MouseFacts,
  type Rows,
  type Selection,
} from "./selection";
import { linkSpan, openableLink, plainUrlAt } from "./links";
import { applyControl, gridOf, newControlView, setMarks } from "./paneGrids";

/** Rows from lines of text, a wide character followed by its `""` half. */
function rows(lines: string[], width: number, wrapped: number[] = []): Rows {
  const chars: string[] = [];
  for (const line of lines) {
    const cells: string[] = [];
    for (const ch of line) {
      cells.push(ch);
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cells.push("");
    }
    while (cells.length < width) cells.push(" ");
    chars.push(...cells.slice(0, width));
  }
  return gridRows({ width, height: lines.length, chars }, new Set(wrapped));
}

const sel = (
  anchor: [number, number],
  head: [number, number],
  unit: Selection["unit"] = "cell",
): Selection => ({
  pane: 1,
  anchor: { x: anchor[0], y: anchor[1] },
  head: { x: head[0], y: head[1] },
  unit,
});

describe("selection geometry", () => {
  const screen = rows(["$ echo hello-world (x)", "second line", ""], 24);

  it("a drag selects its cells, both ends, in reading order whichever way it went", () => {
    expect(selectedText(sel([2, 0], [5, 0]), screen)).toBe("echo");
    expect(selectedText(sel([5, 0], [2, 0]), screen)).toBe("echo");
    expect(selectionSpans(sel([7, 0], [5, 1]), screen)).toEqual([
      { y: 0, x0: 7, x1: 23 },
      { y: 1, x0: 0, x1: 5 },
    ]);
    // Each row its own line, its trailing blanks dropped.
    expect(selectedText(sel([7, 0], [5, 1]), screen)).toBe(
      "hello-world (x)\nsecond",
    );
  });

  it("a word is a run of word characters, of blanks, or one boundary character", () => {
    expect(wordAt(screen, { x: 9, y: 0 })).toEqual({
      start: { x: 7, y: 0 },
      end: { x: 17, y: 0 },
    });
    expect(selectedText(sel([9, 0], [9, 0], "word"), screen)).toBe(
      "hello-world",
    );
    expect(selectedText(sel([19, 0], [19, 0], "word"), screen)).toBe("(");
    expect(selectedText(sel([20, 0], [20, 0], "word"), screen)).toBe("x");
    // A drag by words takes whole words at both ends.
    expect(selectedText(sel([3, 0], [9, 0], "word"), screen)).toBe(
      "echo hello-world",
    );
  });

  it("a line is the whole row, and the rows a soft wrap goes on in", () => {
    const wrapped = rows(["abcdef", "ghi", "next"], 6, [0]);
    expect(lineAt(wrapped, 1)).toEqual({
      start: { x: 0, y: 0 },
      end: { x: 5, y: 1 },
    });
    expect(selectedText(sel([1, 1], [1, 1], "line"), wrapped)).toBe(
      "abcdefghi",
    );
    expect(selectedText(sel([0, 2], [0, 2], "line"), wrapped)).toBe("next");
    // A word goes on across the wrap too.
    expect(selectedText(sel([4, 0], [4, 0], "word"), wrapped)).toBe(
      "abcdefghi",
    );
  });

  it("takes a wide character whole at either edge, and copies it once", () => {
    const cjk = rows(["a日本語b c"], 12);
    // The edges on the right half of 日 and the left half of 語.
    expect(selectionSpans(sel([2, 0], [5, 0]), cjk)).toEqual([
      { y: 0, x0: 1, x1: 6 },
    ]);
    expect(selectedText(sel([2, 0], [5, 0]), cjk)).toBe("日本語");
    // Backwards, the same cells.
    expect(selectedText(sel([5, 0], [2, 0]), cjk)).toBe("日本語");
    // A word of wide characters, clicked on a right half.
    expect(selectedText(sel([4, 0], [4, 0], "word"), cjk)).toBe("a日本語b");
  });

  it("a shift-click moves the end nearer the click", () => {
    const s = sel([5, 0], [10, 0]);
    expect(extendTo(s, { x: 2, y: 0 })).toMatchObject({
      anchor: { x: 10, y: 0 },
      head: { x: 2, y: 0 },
    });
    expect(extendTo(s, { x: 14, y: 0 })).toMatchObject({
      anchor: { x: 5, y: 0 },
      head: { x: 14, y: 0 },
    });
  });
});

describe("routeMouse", () => {
  // The person's tmux.conf: root MouseDrag1Pane unbound, the double and
  // triple clicks bound; copy-mode-vi's drag tmux's own.
  const tmux = {
    on: true,
    root: ["MouseDown1Pane", "DoubleClick1Pane", "TripleClick1Pane"],
    copy: [
      "MouseDown1Pane",
      "MouseDrag1Pane",
      "DoubleClick1Pane",
      "TripleClick1Pane",
    ],
  };
  const facts = (over: Partial<MouseFacts>): MouseFacts => ({
    neovim: false,
    forced: false,
    reports: false,
    copyMode: false,
    tmux,
    ...over,
  });

  it("a shell's drag is DevHub's when tmux binds none; its double-click tmux's", () => {
    expect(routeMouse("drag", facts({}))).toBe("devhub");
    expect(routeMouse("double", facts({}))).toBe("tmux");
    expect(routeMouse("triple", facts({}))).toBe("tmux");
  });

  it("in copy mode the mouse drives tmux's own selection", () => {
    expect(routeMouse("drag", facts({ copyMode: true }))).toBe("tmux");
    expect(routeMouse("double", facts({ copyMode: true }))).toBe("tmux");
    // MouseDragEnd1Pane unbound (the person's): the release is nobody's.
    expect(routeMouse("end", facts({ copyMode: true }))).toBe("devhub");
  });

  it("a program that grabs the mouse gets it; Shift or Option forces DevHub's selection", () => {
    expect(routeMouse("drag", facts({ reports: true }))).toBe("program");
    expect(routeMouse("double", facts({ reports: true }))).toBe("program");
    expect(routeMouse("drag", facts({ reports: true, forced: true }))).toBe(
      "devhub",
    );
    expect(routeMouse("drag", facts({ copyMode: true, forced: true }))).toBe(
      "devhub",
    );
  });

  it("with tmux's mouse off, or its bindings unknown, the selection is DevHub's", () => {
    expect(routeMouse("double", facts({ tmux: { ...tmux, on: false } }))).toBe(
      "devhub",
    );
    expect(routeMouse("double", facts({ tmux: undefined }))).toBe("devhub");
  });

  it("a Neovim in the pane takes its own mouse, modifiers or not", () => {
    expect(routeMouse("drag", facts({ neovim: true, forced: true }))).toBe(
      "neovim",
    );
  });
});

describe("links", () => {
  it("an OSC 8 link's cells are the run of its id, across rows", () => {
    const screen = rows(["see LINK", "TEXT more"], 8);
    const ids = (x: number, y: number) =>
      (y === 0 && x >= 4) || (y === 1 && x < 4) ? 7 : 0;
    const span = linkSpan(
      screen,
      ids,
      (id) => (id === 7 ? "https://a.example/" : undefined),
      {
        x: 1,
        y: 1,
      },
    );
    expect(span).toEqual({
      uri: "https://a.example/",
      start: { x: 4, y: 0 },
      end: { x: 3, y: 1 },
    });
    expect(linkSpan(screen, ids, () => "x", { x: 0, y: 0 })).toBeUndefined();
  });

  it("finds a plain URL under the pointer, whole across a soft wrap, without the text's punctuation", () => {
    const screen = rows(["go to https://exa", "mple.com/a_(b). ok"], 17, [0]);
    expect(plainUrlAt(screen, { x: 3, y: 1 })).toEqual({
      uri: "https://example.com/a_(b)",
      start: { x: 6, y: 0 },
      end: { x: 13, y: 1 },
    });
    expect(plainUrlAt(screen, { x: 1, y: 0 })).toBeUndefined();
    expect(
      plainUrlAt(rows(["(see https://x.example/y)"], 30), { x: 8, y: 0 })?.uri,
    ).toBe("https://x.example/y");
  });

  it("opens the web, mail and FTP, and nothing that could run something here", () => {
    expect(openableLink("https://example.com")).toBe(true);
    expect(openableLink("mailto:a@b.c")).toBe(true);
    expect(openableLink("file:///Applications/Calculator.app")).toBe(false);
    expect(openableLink("x-custom:run")).toBe(false);
  });
});

describe("a pane's frames carry its links into the view", () => {
  const frame = (
    rows: { y: number; text: string; links?: number[]; wrapped?: boolean }[],
    links?: [number, string][],
  ) => ({
    kind: "pane" as const,
    seq: 1,
    pane: 3,
    modes: {
      mouse: 0,
      sgrMouse: false,
      bracketedPaste: false,
      focusEvents: false,
      alternateScreen: false,
    },
    frame: {
      cols: 6,
      rows: 2,
      full: false,
      cursor: undefined,
      styles: [],
      dirty: rows.map((r) => ({
        y: r.y,
        cells: [...r.text.padEnd(6)],
        styles: new Uint32Array(6),
        ...(r.links === undefined ? {} : { links: Uint32Array.from(r.links) }),
        ...(r.wrapped === true ? { wrapped: true } : {}),
      })),
      ...(links === undefined ? {} : { links }),
    },
  });

  it("keeps each cell's link id and the URI the frame names, and the wrapped rows", () => {
    const view = newControlView({ foreground: 0, background: 0xffffff });
    applyControl(
      view,
      frame(
        [{ y: 0, text: "go now", links: [0, 0, 0, 2, 2, 2], wrapped: true }],
        [[2, "https://a.example/"]],
      ),
    );
    const grid = gridOf(3);
    expect([...(view.linkIds.get(grid) ?? [])].slice(0, 6)).toEqual([
      0, 0, 0, 2, 2, 2,
    ]);
    expect(view.linkUris.get(grid)?.get(2)).toBe("https://a.example/");
    expect(view.wrapped.get(grid)?.has(0)).toBe(true);
    // The row redrawn without links (or a wrap): none any more.
    applyControl(view, frame([{ y: 0, text: "plain" }]));
    expect([...(view.linkIds.get(grid) ?? [])].slice(0, 6)).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(view.wrapped.get(grid)?.has(0)).toBe(false);
  });

  it("draws DevHub's selection and the hovered link over the cells, and takes them away", () => {
    const view = newControlView({ foreground: 0, background: 0xffffff });
    applyControl(view, frame([{ y: 0, text: "abcdef" }]));
    const grid = view.state.grids.get(gridOf(3));
    const own = grid?.hls[1];
    setMarks(view, 3, {
      selection: [{ y: 0, x0: 1, x1: 2 }],
      underline: [{ y: 0, x0: 2, x1: 3 }],
    });
    const hl = (x: number) => view.state.hl.get(grid?.hls[x] ?? 0) ?? {};
    expect(hl(1).background).toBe(view.selection);
    expect(hl(2)).toMatchObject({
      background: view.selection,
      underline: true,
    });
    expect(hl(3).underline).toBe(true);
    expect(hl(3).background).toBeUndefined();
    setMarks(view, 3, { selection: [], underline: [] });
    expect(grid?.hls[1]).toBe(own);
    expect(view.marks.has(3)).toBe(false);
  });
});
