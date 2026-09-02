/**
 * The Mac editing chords, and the bytes they become.
 *
 * These are not ours to choose and they are not derived from anything: they are
 * the five default keybinds Ghostty installs on macOS, copied from `Config.zig`
 * — `super+left` sends `\x01`, `super+right` `\x05`, `super+backspace` `\x15`,
 * and `alt` with an arrow sends `ESC b` or `ESC f`. Ghostty's own comment calls
 * them the "natural text editing" keybinds and notes that they deliberately
 * bypass its key encoder.
 *
 * That bypass is the whole point. The encoded form of Cmd+Left, `CSI 1;9D`,
 * cannot reach a program through tmux: tmux has no Super modifier and folds it
 * into Meta, so it arrives as Option+Left and moves by a word. A single byte
 * has no modifier to lose.
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
  it("sends Cmd+Left and Cmd+Right the bytes Ghostty binds them to", () => {
    expect(editingSequence(chord("ArrowLeft", { metaKey: true }))).toBe("\u0001");
    expect(editingSequence(chord("ArrowRight", { metaKey: true }))).toBe("\u0005");
  });

  it("sends Cmd+Backspace the byte Ghostty binds it to", () => {
    expect(editingSequence(chord("Backspace", { metaKey: true }))).toBe("\u0015");
  });

  /**
   * Ghostty binds these too, as `esc b` and `esc f`, rather than leaving them
   * to the encoder — which would send `CSI 1;3D`. Matching Ghostty means
   * claiming them here even though xterm would encode something workable.
   */
  it("sends Option with an arrow as the word motion Ghostty binds", () => {
    expect(editingSequence(chord("ArrowLeft", { altKey: true }))).toBe("\u001bb");
    expect(editingSequence(chord("ArrowRight", { altKey: true }))).toBe("\u001bf");
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

  it("leaves a bare arrow and a bare Backspace to xterm", () => {
    expect(editingSequence(chord("ArrowLeft"))).toBeUndefined();
    expect(editingSequence(chord("ArrowRight"))).toBeUndefined();
    expect(editingSequence(chord("Backspace"))).toBeUndefined();
  });

  /**
   * Ghostty's bindings match a modifier set exactly, so a chord holding
   * anything extra falls through to its encoder — which is what xterm does
   * here on its own.
   */
  it("does not claim a chord holding an extra modifier", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, shiftKey: true })),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowLeft", { altKey: true, shiftKey: true })),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, ctrlKey: true })),
    ).toBeUndefined();
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, altKey: true })),
    ).toBeUndefined();
  });

  /** Ghostty binds no vertical arrow, so neither does this. */
  it("claims no vertical arrow", () => {
    expect(editingSequence(chord("ArrowUp", { metaKey: true }))).toBeUndefined();
    expect(
      editingSequence(chord("ArrowDown", { metaKey: true })),
    ).toBeUndefined();
    expect(editingSequence(chord("ArrowUp", { altKey: true }))).toBeUndefined();
  });
});
