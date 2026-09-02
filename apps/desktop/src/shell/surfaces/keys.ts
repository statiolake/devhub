/**
 * Cmd+Left and Cmd+Right, which a terminal has to spell as some other key.
 *
 * On a Mac these two mean "beginning of the line" and "end of the line" — the
 * system's own editing keys, the ones people arrive with in their fingers. A
 * terminal has no "Cmd" to put on the wire, so the question is only ever which
 * key to report instead, and the answer here is the one macOS itself gives:
 * Home and End. They go out spelled exactly as xterm spells them for the Home
 * and End keys, cursor-key mode included, so a pane says nothing it would not
 * have said had the keyboard carried those keys in the first place.
 *
 * ## Why not the modified arrow Ghostty sends
 *
 * Ghostty reports Cmd+Left faithfully, as `CSI 1;9D` — a left arrow with the
 * Super modifier, from the table in its `function_keys.zig`. That is the more
 * honest encoding and it was tried first. It cannot work here, and the reason
 * is not a matter of configuration.
 *
 * Every DevHub pane is a tmux pane, and tmux has no Super. Its key type has
 * three modifier bits, Meta, Ctrl and Shift (`tmux.h`), and its input parser
 * folds the Super bit into Meta on the way in:
 *
 *     if (modifiers & 2) nkey |= (KEYC_META|KEYC_IMPLIED_META); // Alt
 *     if (modifiers & 8) nkey |= (KEYC_META|KEYC_IMPLIED_META); // Meta
 *
 * So `CSI 1;9D` and `CSI 1;3D` become the same key inside tmux — measured, the
 * identical key code — and tmux hands the program `CSI 1;3D`, which is
 * Option+Left, which is a word motion. That is exactly what a viewer saw: Cmd
 * with an arrow moving by a word. It is not DevHub's bug to fix by
 * configuration; every `extended-keys` and `terminal-features` combination was
 * measured and none of them change it, because the modifier is discarded
 * before any of those options are consulted. Ghostty is no exception: with the
 * user's own tmux configuration and `TERM=xterm-ghostty`, Cmd+Left arrives at
 * the program as `CSI 1;3D` too. What a viewer compares against is Ghostty
 * *without* tmux, where nothing is in the way.
 *
 * Home and End have no modifier to lose, so they pass through tmux unchanged.
 * Measured with Claude Code inside tmux, in the arrangement a pane actually
 * uses: Cmd+Left moves to the start of the line and Cmd+Right to the end.
 *
 * ## What is deliberately left alone
 *
 * Option with an arrow is already encoded correctly by xterm as `CSI 1;3D`,
 * the word motion, and survives tmux intact — so there is no rule for it here.
 * Cmd+Backspace already sends `DEL`, which is what Ghostty sends for it too.
 * Cmd+Up and Cmd+Down mean "the ends of the document", which a line editor has
 * no key for, so nothing is invented for them. And Cmd+C, Cmd+V and Cmd+A
 * belong to the browser and to DevHub's own menus.
 *
 * A stock zsh binds neither Home nor End and so ignores both. That is the same
 * in every Mac terminal, Ghostty included, and a shell that wants these keys
 * binds them.
 */

/** Just enough of a keyboard event to decide, so the rule can be tested. */
export interface EditingChord {
  readonly key: string;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The bytes for one chord, or nothing when the chord is not ours.
 *
 * `applicationCursorKeys` is the terminal's current DECCKM state, and it
 * decides which of the two spellings of Home and End is the right one — a
 * program that asked for application cursor keys reads the SS3 form and does
 * not recognise the CSI one. It is the caller's to pass because it is the
 * terminal's to know, and it changes while a pane is open.
 */
export function editingSequence(
  chord: EditingChord,
  applicationCursorKeys: boolean,
): string | undefined {
  // Only Command alone. A chord that also holds Shift is asking for a
  // selection, which a terminal cannot express; Control and Option are the
  // terminal's own modifiers and xterm already spells those.
  if (!chord.metaKey || chord.shiftKey || chord.ctrlKey || chord.altKey) {
    return undefined;
  }
  if (chord.key === "ArrowLeft")
    return applicationCursorKeys ? "\u001bOH" : "\u001b[H";
  if (chord.key === "ArrowRight")
    return applicationCursorKeys ? "\u001bOF" : "\u001b[F";
  return undefined;
}
