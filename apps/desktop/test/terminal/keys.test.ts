/**
 * Cmd+Left and Cmd+Right, and the keys they are reported as.
 *
 * Every one of these was measured rather than reasoned about, in the
 * arrangement a pane actually uses — Claude Code running inside tmux, driven
 * through a pty. Home and End move to the ends of the line there. The modified
 * arrow Ghostty sends, `CSI 1;9D`, does not: tmux has no Super modifier and
 * folds it into Meta on the way in, so it reaches the program as `CSI 1;3D`
 * and moves by a word. See the note in `keys.ts` for the whole finding.
 */

import { describe, expect, it } from "vitest";
import {
  editingSequence,
  type EditingChord,
} from "../../src/shell/surfaces/keys";

function chord(key: string, held: Partial<EditingChord> = {}): EditingChord {
  return {
    key,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...held,
  };
}

describe("Cmd with a left or right arrow", () => {
  it("is reported as the Home and End keys", () => {
    expect(editingSequence(chord("ArrowLeft", { metaKey: true }), false)).toBe(
      "\u001b[H",
    );
    expect(editingSequence(chord("ArrowRight", { metaKey: true }), false)).toBe(
      "\u001b[F",
    );
  });

  /**
   * The two spellings are not a preference. A program that asked for
   * application cursor keys reads the SS3 form and does not recognise the CSI
   * one, and this is the same choice xterm makes for a real Home key.
   */
  it("uses the SS3 spelling when the program asked for application keys", () => {
    expect(editingSequence(chord("ArrowLeft", { metaKey: true }), true)).toBe(
      "\u001bOH",
    );
    expect(editingSequence(chord("ArrowRight", { metaKey: true }), true)).toBe(
      "\u001bOF",
    );
  });

  /**
   * Option with an arrow is already the word motion, `CSI 1;3D`, encoded by
   * xterm and passed through tmux intact. Claiming it here would be a second
   * path saying the same thing.
   */
  it("leaves Option with an arrow to xterm", () => {
    expect(
      editingSequence(chord("ArrowLeft", { altKey: true }), false),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowRight", { altKey: true }), false),
    ).toBeUndefined();
  });

  it("leaves a bare arrow to xterm", () => {
    expect(editingSequence(chord("ArrowLeft"), false)).toBeUndefined();
    expect(editingSequence(chord("ArrowRight"), false)).toBeUndefined();
  });

  /** A terminal has no way to say "select to here", so the key is not taken. */
  it("does not claim a chord that is asking for a selection", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, shiftKey: true }), false),
    ).toBeUndefined();
  });

  /** Control and Option are the terminal's own modifiers; xterm spells those. */
  it("does not claim Command held with another modifier", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, ctrlKey: true }), false),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, altKey: true }), false),
    ).toBeUndefined();
  });

  /**
   * Cmd+Up and Cmd+Down mean the ends of the document, which a line editor has
   * no key for; Cmd+Backspace already sends DEL, as it does in Ghostty; and
   * Cmd+C and its relatives belong to the browser and DevHub's own menus.
   */
  it("claims nothing but the two horizontal arrows", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Backspace", "c", "v", "a", "z"]) {
      expect(editingSequence(chord(key, { metaKey: true }), false)).toBeUndefined();
    }
  });
});
