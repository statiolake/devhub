/**
 * Whether this key event's Option is Meta, by `[terminal] mac_option_is_meta`.
 *
 * The decision is made here, per event, for DevHub's terminals
 * (`terminal/control/controlKeys.ts`) and the Neovim editor
 * (`neovim/keys.ts`): Option as Meta is the key as tmux or Neovim names it
 * with `M-` — `M-x` for Option+X, `M-X` with Shift, Option+E as `M-e` rather
 * than a dead key — and what is decided here is *which* Option presses that
 * applies to.
 *
 * - `false`: never. Option composes, as on any Mac text field (the default).
 * - `true`: always.
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
 * No key is excepted: under `true` every Option chord is Meta, including the
 * ones a layout types a character with (Option+¥ is `\` on a JIS Mac). Who
 * needs those and Alt mappings both uses `"left"`, as in iTerm2 and Ghostty.
 *
 * Off a Mac none of this matters: Alt is Meta there regardless of the
 * setting.
 */

import type { MacOptionIsMeta } from "../../model/macOption";

/** Just enough of a keyboard event to decide, so the rule can be tested. */
export interface OptionKeyEvent {
  readonly type: string;
  readonly code: string;
  readonly altKey: boolean;
  /** `KeyboardEvent.key`/`location`: a left `Alt` with no `code` counts. */
  readonly key?: string;
  readonly location?: number;
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
    const leftOption =
      event.code === "AltLeft" ||
      (event.code === "" && event.key === "Alt" && event.location === 1);
    if (leftOption) this.left = event.type !== "keyup";
    if (!event.altKey) this.left = false;
    if (setting === false) return false;
    if (setting === true) return true;
    return this.left;
  }
}

/**
 * The composition a Meta key starts, kept from the page.
 *
 * Option+E, N, U, I and `` ` `` are dead keys on a US layout (and others on
 * other layouts), and macOS starts their composition before the page sees
 * the keydown; cancelling the keydown does not stop it. So a composition
 * that starts on a keydown that was sent as Meta is dropped from its start
 * to its end — no preedit, no commit — and the keys typed meanwhile are the
 * surface's to send (the next Meta chord, or the plain key that would have
 * committed the mark). One that starts on any other key — the right Option
 * under `"left"`, every Option under `false`, an IME — is untouched, so
 * Option+E then e is still `é`.
 */
export class MetaComposition {
  private lastWasMeta = false;
  private dropping = false;

  /** Whether a Meta key's composition is being dropped now. */
  get active(): boolean {
    return this.dropping;
  }

  /** Every keydown the surface sees: whether it was sent as Meta. */
  keydown(sentAsMeta: boolean): void {
    this.lastWasMeta = sentAsMeta;
  }

  /**
   * A composition or input event: `true` when it is to be dropped. The
   * `compositionend` that ends a dropped composition is dropped too.
   */
  drops(type: string): boolean {
    if (type === "compositionstart") this.dropping = this.lastWasMeta;
    const drop = this.dropping;
    if (type === "compositionend") this.dropping = false;
    return drop;
  }

  /** Focus lost: whatever was in flight is over. */
  reset(): void {
    this.lastWasMeta = false;
    this.dropping = false;
  }
}
