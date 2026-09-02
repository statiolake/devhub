/**
 * The arrow keys held with Command, which xterm drops on the floor.
 *
 * A terminal has no "Cmd" on the wire, but it does have a way to say "this
 * key, with these modifiers held": the xterm convention writes a cursor key as
 * `CSI 1 ; <modifiers> <letter>`, where the modifier number is one plus a
 * bitmask of Shift, Alt, Control and Super. Cmd+Left is `CSI 1;9D` — 1 plus 8
 * for Super — and that is exactly what Ghostty emits for it, from the same
 * table it uses for every other modified cursor key. A program that decodes
 * modified arrows gets a real Cmd+Left and decides for itself what that means.
 *
 * xterm.js already computes this. Its keyboard encoder builds the very same
 * number, including 8 for `metaKey`, and then the arrow cases begin with an
 * early `if (ev.metaKey) break`, which throws the result away and emits
 * nothing at all. That is the whole defect: not a missing translation, a
 * discarded one. What this module does is reproduce the encoding xterm.js
 * would have emitted had it not bailed out, so DevHub's panes speak the same
 * bytes as every other Mac terminal.
 *
 * Nothing else here needs a rule, and adding one would be inventing behaviour
 * rather than restoring it. Option with an arrow is already encoded correctly —
 * `CSI 1;3D`, the word motion — because that path has no bail-out. Cmd with
 * Backspace already sends `DEL`, which is what Ghostty sends for it too.
 *
 * ## What this does and does not fix, measured
 *
 * Claude Code's prompt decodes all four modified arrows: `CSI 1;9D` and
 * `CSI 1;9C` move to the ends of the line, `CSI 1;3D` and `CSI 1;3C` move by a
 * word. A stock zsh decodes none of them — it binds no modified arrow at all,
 * so Cmd+Left leaves the tail of the sequence in the line buffer. That is not
 * a gap to paper over here: Ghostty emits the same bytes and a zsh under
 * Ghostty behaves the same way, with no shell integration of its own to make up
 * the difference. A shell that wants these keys binds them, and the terminal's
 * job is to report the key that was pressed.
 */

/** Just enough of a keyboard event to decide, so the rule can be tested. */
export interface EditingChord {
  readonly key: string;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/** The final byte of the CSI sequence for each cursor key. */
const CURSOR_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
};

/**
 * The bytes for one chord, or nothing when xterm already encodes it.
 *
 * Only a cursor key held with Command is claimed, because that is the only one
 * xterm refuses to encode. The modifier number is xterm.js's own formula, so a
 * chord that also holds Shift or Control keeps saying so.
 */
export function editingSequence(chord: EditingChord): string | undefined {
  if (!chord.metaKey) return undefined;
  const final = CURSOR_KEYS[chord.key];
  if (final === undefined) return undefined;
  const modifiers =
    1 +
    (chord.shiftKey ? 1 : 0) +
    (chord.altKey ? 2 : 0) +
    (chord.ctrlKey ? 4 : 0) +
    8;
  return `\u001b[1;${modifiers}${final}`;
}
