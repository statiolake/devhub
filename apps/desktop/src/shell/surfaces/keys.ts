/**
 * The macOS text-editing chords a terminal is expected to understand.
 *
 * A Mac terminal is not just a grid: people arrive with the system's editing
 * keys in their fingers, and iTerm and Ghostty both answer them. Cmd+Left and
 * Cmd+Right go to the beginning and end of the line, Cmd+Backspace deletes back
 * to the beginning, and Option with an arrow moves by a word. None of these
 * exist in a terminal's own vocabulary — there is no "Cmd" on the wire — so
 * each one has to be translated into bytes the program on the other end
 * already knows.
 *
 * Translating them settles something else too. A chord DevHub does not answer
 * is a chord the browser answers instead, on the hidden textarea xterm keeps
 * for IME input, by moving a caret nothing else can see. That is what turned
 * Japanese input into the tail of the previous Japanese input; that is fixed at
 * its own root now, but a chord claimed here can never reach the textarea at
 * all.
 *
 * What is deliberately *not* claimed: Cmd+C, Cmd+V, Cmd+A and every other
 * system shortcut, which belong to the browser and to DevHub's own menus; and
 * anything with Shift, because a terminal has no way to express a selection and
 * guessing at one would be worse than leaving the key alone.
 *
 * ## Why these bytes and not the Home and End keys
 *
 * The obvious translation of Cmd+Left is whatever a Home key sends, and it does
 * not work. Measured against a real zsh under a real pty: `ESC [ H`, `ESC O H`
 * and `ESC [ 1 ~` all leave the cursor where it was, because a stock zsh binds
 * none of them — the escape is swallowed and so is the next character typed.
 * Claude Code's prompt accepts all of them and also accepts `C-a`, so `C-a` and
 * `C-e` are the only spelling that works in both places, and they work in bash,
 * readline and every other line editor besides. Choosing them also removes a
 * question that would otherwise have to be answered on every press: the two
 * escape spellings of Home differ by the terminal's cursor-key mode, and
 * `C-a` does not have two spellings.
 *
 * The price is honest and worth stating. `C-a` is a popular tmux prefix, and a
 * pane running under a tmux configured that way will take Cmd+Left as the
 * prefix. That is the same price iTerm and Ghostty charge for the same chord.
 *
 * `C-u` is the same kind of compromise. On a Mac, Cmd+Backspace deletes what is
 * behind the cursor and keeps the rest; Claude Code's prompt does exactly that,
 * while zsh reads `C-u` as "kill the whole line" and drops what was ahead of
 * the cursor too. No byte means delete-to-start everywhere, `C-u` is what a Mac
 * terminal sends, and a shell that wants the Mac behaviour can bind it.
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
  // Shift means a selection, which a terminal cannot express; Control is the
  // terminal's own modifier and xterm already spells those.
  if (chord.shiftKey || chord.ctrlKey) return undefined;
  if (chord.metaKey && !chord.altKey) {
    // SOH and ENQ: beginning-of-line and end-of-line to every line editor.
    if (chord.key === "ArrowLeft") return "\u0001";
    if (chord.key === "ArrowRight") return "\u0005";
    // NAK: what a Mac terminal sends for Cmd+Backspace.
    if (chord.key === "Backspace") return "\u0015";
    return undefined;
  }
  if (chord.altKey && !chord.metaKey) {
    // The Emacs-style word motions a Mac terminal sends, and the ones
    // readline and zsh bind by default.
    if (chord.key === "ArrowLeft") return "\u001bb";
    if (chord.key === "ArrowRight") return "\u001bf";
    return undefined;
  }
  return undefined;
}
