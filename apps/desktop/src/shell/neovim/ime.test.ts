import { describe, expect, it } from "vitest";
import { IDLE, imeStep, type ImeEvent, type ImeState } from "./ime";

function run(events: readonly ImeEvent[]): {
  commits: string[];
  state: ImeState;
  preedits: string[];
} {
  let state = IDLE;
  const commits: string[] = [];
  const preedits: string[] = [];
  for (const event of events) {
    const step = imeStep(state, event);
    state = step.state;
    if (step.commit !== undefined) commits.push(step.commit);
    preedits.push(state.preedit);
  }
  return { commits, state, preedits };
}

describe("text input and the IME", () => {
  it("sends typed text once", () => {
    expect(
      run([
        {
          type: "input",
          inputType: "insertText",
          data: "a",
          isComposing: false,
        },
      ]).commits,
    ).toEqual(["a"]);
  });

  it("shows a Japanese preedit and sends only the committed text, once", () => {
    const { commits, preedits, state } = run([
      { type: "compositionstart" },
      { type: "compositionupdate", data: "に" },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "に",
        isComposing: true,
      },
      { type: "compositionupdate", data: "にほんご" },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "にほんご",
        isComposing: true,
      },
      { type: "compositionupdate", data: "日本語" },
      // Chromium's own input for the commit, then the end: one commit.
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "日本語",
        isComposing: true,
      },
      { type: "compositionend", data: "日本語" },
    ]);
    expect(commits).toEqual(["日本語"]);
    expect(preedits).toContain("にほんご");
    expect(state).toEqual(IDLE);
  });

  it("commits a dead key's character", () => {
    expect(
      run([
        { type: "compositionstart" },
        { type: "compositionupdate", data: "´" },
        { type: "compositionend", data: "é" },
      ]).commits,
    ).toEqual(["é"]);
  });

  it("drops a composition the page lost focus in", () => {
    const { commits, state } = run([
      { type: "compositionstart" },
      { type: "compositionupdate", data: "か" },
      { type: "reset" },
      {
        type: "input",
        inputType: "deleteContentBackward",
        data: null,
        isComposing: false,
      },
    ]);
    expect(commits).toEqual([]);
    expect(state).toEqual(IDLE);
  });

  it("sends a cancelled composition as nothing", () => {
    expect(
      run([{ type: "compositionstart" }, { type: "compositionend", data: "" }])
        .commits,
    ).toEqual([]);
  });
});

describe("the preedit, cell by cell", () => {
  it("takes the cells the grid gives each character", async () => {
    const { cellsOf, preeditLayout } = await import("./ime");
    expect(cellsOf("a")).toBe(1);
    expect(cellsOf("に")).toBe(2);
    expect(cellsOf("漢")).toBe(2);
    expect(cellsOf("ｱ")).toBe(1); // halfwidth katakana
    expect(cellsOf("Ａ")).toBe(2); // fullwidth
    expect(cellsOf("゙")).toBe(0); // a combining voiced mark
    expect(preeditLayout("aにほ")).toEqual({
      chars: [
        { ch: "a", col: 0, cells: 1 },
        { ch: "に", col: 1, cells: 2 },
        { ch: "ほ", col: 3, cells: 2 },
      ],
      cells: 5,
    });
    // A combining mark joins the character before it.
    expect(preeditLayout("がき").chars).toEqual([
      { ch: "が", col: 0, cells: 2 },
      { ch: "き", col: 2, cells: 2 },
    ]);
  });
});
