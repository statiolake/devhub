/**
 * Whether this key event's Option is Meta, by `[terminal] mac_option_is_meta`.
 *
 * xterm.js has one switch for it, `macOptionIsMeta`, and reads it inside its
 * own keydown handler, after the custom key handler has run. So the decision is
 * made here, per event, and the switch is set to it just before xterm looks:
 * xterm still does every bit of the encoding — `ESC x` for Option+X, `ESC X`
 * with Shift, `ESC ^X` with Control, Option+E as `ESC e` rather than a dead key
 * — and the only thing DevHub adds is *which* Option presses that applies to.
 *
 * - `false`: never. Option composes, as on any Mac text field (the default).
 * - `true`: always, as xterm's own switch.
 * - `"left"`: only while the left Option is held, so the right one still types
 *   `≈`, `@` or `{` — what iTerm2's "Left Option key: Esc+" and Ghostty's
 *   `macos-option-as-alt = left` do. A letter's keydown does not say which
 *   Option is down (`location` is the letter's), so the sides are followed from
 *   the left Option's own keydown and keyup (`AltLeft`). One nobody saw go
 *   down — Option already held when the terminal took focus — counts as not
 *   held, so the failure mode is a composed character rather than an `ESC`
 *   nobody asked for. Any event without Option forgets it, so a keyup lost to
 *   another window cannot leave it stuck.
 *
 * Whatever the setting, Option+¥ (`IntlYen`, the key left of Backspace on a
 * Japanese keyboard) composes. On a JIS Mac that is how `\` is typed, and as
 * Meta it would be `ESC \` — a terminal in which a backslash cannot be typed.
 *
 * Off a Mac none of this matters: xterm reads Alt as Meta there regardless of
 * the switch.
 */

import type { MacOptionIsMeta } from "../../model/macOption";

/** Just enough of a keyboard event to decide, so the rule can be tested. */
export interface OptionKeyEvent {
  readonly type: string;
  readonly code: string;
  readonly altKey: boolean;
}

export class OptionKeys {
  /** Whether the left Option is down. The right one never needs asking. */
  private left = false;

  /**
   * Note `event` and say whether its Option is Meta under `setting`.
   *
   * Every key event the terminal sees has to come through here — keyup
   * included — or the sides fall out of step with the keyboard.
   */
  isMeta(setting: MacOptionIsMeta, event: OptionKeyEvent): boolean {
    if (event.code === "AltLeft") this.left = event.type !== "keyup";
    if (!event.altKey) this.left = false;
    if (setting === false) return false;
    // Composes whatever the setting: the JIS backslash.
    if (event.code === "IntlYen") return false;
    if (setting === true) return true;
    return this.left;
  }
}
