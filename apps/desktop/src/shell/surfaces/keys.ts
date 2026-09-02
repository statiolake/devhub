/**
 * The Mac editing chords, sent as the bytes Ghostty sends for them.
 *
 * A Mac terminal is not just a grid: people arrive with the system's editing
 * keys in their fingers. Cmd+Left and Cmd+Right go to the beginning and end of
 * the line, Cmd+Backspace deletes back to the beginning, and Option with an
 * arrow moves by a word. None of these exist in a terminal's own vocabulary —
 * there is no "Cmd" on the wire — so each has to become bytes.
 *
 * Which bytes is not a judgement call, and it is not the encoding table either.
 * Ghostty ships these five as default keybinds on macOS, in `Config.zig`, under
 * a comment that says exactly why:
 *
 *     // "Natural text editing" keybinds. This forces these keys to go back
 *     // to legacy encoding (not fixterms). It seems macOS users more than
 *     // others are used to these keys so we set them as defaults.
 *     arrow_right + super  -> text "\x05"
 *     arrow_left  + super  -> text "\x01"
 *     backspace   + super  -> text "\x15"
 *     arrow_left  + alt    -> esc "b"
 *     arrow_right + alt    -> esc "f"
 *
 * So a Cmd+Left in Ghostty never reaches its key encoder at all: the binding
 * wins first and one byte goes out. That is what this reproduces, byte for
 * byte, and it is why a viewer sees Cmd+Left jump to the start of the line in
 * Ghostty with tmux in the way. These carry no modifier for tmux to lose.
 *
 * The faithful-looking alternative — reporting a left arrow with the Super
 * modifier, `CSI 1;9D`, which is what Ghostty's encoder *would* produce for an
 * unbound Cmd+Left — was tried here and is wrong twice over. Ghostty does not
 * send it for this chord, and it cannot survive the trip: tmux has no Super
 * modifier at all. Its key type carries Meta, Ctrl and Shift (`tmux.h`) and its
 * parser folds Super in beside Alt (`tty-keys.c`):
 *
 *     if (modifiers & 2) nkey |= (KEYC_META|KEYC_IMPLIED_META); // Alt
 *     if (modifiers & 8) nkey |= (KEYC_META|KEYC_IMPLIED_META); // Meta
 *
 * Cmd+Left and Option+Left arrive as the same key, so the program reads a word
 * motion. Measured, and no `extended-keys` or `terminal-features` setting
 * changes it. Ghostty's own bindings are what step around this, which is why
 * matching Ghostty means matching its bindings and not its encoder.
 *
 * What is deliberately not claimed: Cmd+C, Cmd+V, Cmd+A and every other system
 * shortcut, which belong to the browser and to DevHub's own menus; and any of
 * these chords held with an extra modifier, because Ghostty's bindings match a
 * modifier set exactly and anything else falls through to the encoder, which
 * xterm already does on its own.
 */

/** Just enough of a keyboard event to decide, so the rule can be tested. */
export interface EditingChord {
  readonly key: string;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/** The bytes for one chord, or nothing when the chord is not ours. */
export function editingSequence(chord: EditingChord): string | undefined {
  // Ghostty's bindings match a modifier set exactly. Shift or Control held as
  // well makes this a different chord, and xterm encodes those itself.
  if (chord.shiftKey || chord.ctrlKey) return undefined;
  if (chord.metaKey && !chord.altKey) {
    if (chord.key === "ArrowLeft") return "\u0001";
    if (chord.key === "ArrowRight") return "\u0005";
    if (chord.key === "Backspace") return "\u0015";
    return undefined;
  }
  if (chord.altKey && !chord.metaKey) {
    if (chord.key === "ArrowLeft") return "\u001bb";
    if (chord.key === "ArrowRight") return "\u001bf";
    return undefined;
  }
  return undefined;
}
