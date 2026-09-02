/**
 * The Mac editing chords, and the bytes they become.
 *
 * The point of pinning the exact sequences is that they are not ours to choose:
 * they are what readline, zsh and Claude Code's prompt already listen for, and
 * a chord that sends something almost right does nothing at all. Each of these
 * was measured against a real zsh and a real Claude Code under a pty before it
 * was written down — see the note in `keys.ts` for what was tried and rejected.
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

describe("the Mac editing chords a terminal answers", () => {
  /**
   * Not the bytes a Home key sends. A stock zsh binds none of the escape
   * spellings of Home — it swallows the escape and the next character with
   * it — while every line editor there is, Claude Code's prompt included,
   * moves to the ends of the line on these two.
   */
  it("sends Cmd+Left and Cmd+Right as beginning- and end-of-line", () => {
    expect(editingSequence(chord("ArrowLeft", { metaKey: true }))).toBe(
      "\u0001",
    );
    expect(editingSequence(chord("ArrowRight", { metaKey: true }))).toBe(
      "\u0005",
    );
  });

  it("sends Cmd+Backspace as the delete a Mac terminal sends", () => {
    expect(editingSequence(chord("Backspace", { metaKey: true }))).toBe(
      "\u0015",
    );
  });

  it("sends Option with an arrow as a word motion", () => {
    expect(editingSequence(chord("ArrowLeft", { altKey: true }))).toBe(
      "\u001bb",
    );
    expect(editingSequence(chord("ArrowRight", { altKey: true }))).toBe(
      "\u001bf",
    );
  });

  /**
   * Everything the system and DevHub's own menus own. Claiming any of these
   * would break copy, paste and select-all in a terminal.
   */
  it("leaves the system shortcuts alone", () => {
    for (const key of ["c", "v", "a", "n", "w", "t", "z"]) {
      expect(editingSequence(chord(key, { metaKey: true }))).toBeUndefined();
    }
  });

  it("leaves a bare arrow to xterm", () => {
    expect(editingSequence(chord("ArrowLeft"))).toBeUndefined();
    expect(editingSequence(chord("ArrowRight"))).toBeUndefined();
    expect(editingSequence(chord("Backspace"))).toBeUndefined();
  });

  /** A terminal has no way to say "select to here", so the key is not taken. */
  it("does not claim a chord that is asking for a selection", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, shiftKey: true })),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowLeft", { altKey: true, shiftKey: true })),
    ).toBeUndefined();
  });

  /** Control is the terminal's own modifier; xterm already spells those. */
  it("leaves anything held with Control to xterm", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, ctrlKey: true })),
    ).toBeUndefined();
    expect(editingSequence(chord("ArrowLeft", { ctrlKey: true }))).toBeUndefined();
  });

  /** Both modifiers at once is not a chord anyone means; leave it. */
  it("does not guess at Cmd and Option together", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, altKey: true })),
    ).toBeUndefined();
  });
});
