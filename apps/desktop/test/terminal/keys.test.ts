/**
 * The arrow keys held with Command, and the bytes they become.
 *
 * These sequences are not ours to choose. They are the xterm convention for a
 * modified cursor key, they are what Ghostty emits from its own table — read
 * out of `src/input/function_keys.zig`, where a left arrow is
 * `ESC [ 1 ; {mods} D` and Super is modifier 9 — and they are what xterm.js's
 * own encoder computes before its arrow cases throw the result away. Claude
 * Code's prompt was measured decoding all four of them under a pty.
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

describe("a cursor key held with Command", () => {
  it("says Command and which arrow it was", () => {
    expect(editingSequence(chord("ArrowLeft", { metaKey: true }))).toBe(
      "\u001b[1;9D",
    );
    expect(editingSequence(chord("ArrowRight", { metaKey: true }))).toBe(
      "\u001b[1;9C",
    );
    expect(editingSequence(chord("ArrowUp", { metaKey: true }))).toBe(
      "\u001b[1;9A",
    );
    expect(editingSequence(chord("ArrowDown", { metaKey: true }))).toBe(
      "\u001b[1;9B",
    );
  });

  /**
   * The point of encoding a key rather than translating it: a chord that holds
   * more than Command still says so, and the program decides what it means.
   * These numbers are the same ones Ghostty's table holds for the same
   * combinations — Shift+Super is 10, Alt+Super 11, Ctrl+Super 13.
   */
  it("keeps saying which other modifiers were held", () => {
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, shiftKey: true })),
    ).toBe("\u001b[1;10D");
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, altKey: true })),
    ).toBe("\u001b[1;11D");
    expect(
      editingSequence(chord("ArrowLeft", { metaKey: true, ctrlKey: true })),
    ).toBe("\u001b[1;13D");
  });

  /**
   * Everything xterm already encodes correctly is left to it. Option with an
   * arrow is the word motion, `ESC [ 1 ; 3 D`, and it reaches the pty today;
   * claiming it here would be a second path saying the same thing.
   */
  it("leaves a chord xterm already encodes alone", () => {
    expect(editingSequence(chord("ArrowLeft", { altKey: true }))).toBeUndefined();
    expect(
      editingSequence(chord("ArrowRight", { altKey: true })),
    ).toBeUndefined();
    expect(editingSequence(chord("ArrowLeft"))).toBeUndefined();
    expect(editingSequence(chord("ArrowLeft", { ctrlKey: true }))).toBeUndefined();
  });

  /**
   * Cmd+Backspace already sends DEL, which is what Ghostty sends for it too,
   * and Cmd+C and its relatives belong to the browser and DevHub's menus.
   */
  it("claims nothing but a cursor key", () => {
    expect(editingSequence(chord("Backspace", { metaKey: true }))).toBeUndefined();
    for (const key of ["c", "v", "a", "n", "w", "t", "z", "Home", "End"]) {
      expect(editingSequence(chord(key, { metaKey: true }))).toBeUndefined();
    }
  });
});
