/**
 * `[terminal] mac_option_is_meta`, the one value both main and the pages read.
 *
 * Kept out of `config.ts` so a page can import it: that module reads files.
 */

/**
 * What macOS's Option key is in DevHub's own terminals: `false` (the default),
 * `true`, or `"left"`.
 *
 * On a Mac, Option is how a keyboard layout reaches its third level: Option+X
 * is `≈` on a US layout, Option+¥ is `\` on a Japanese one, and German, French
 * and the international layouts type `@`, `{`, `[` and `|` with it. A terminal
 * that read Option as Meta would take all of those away, so by default it does
 * not, and Option types what the layout says — which is also why a Neovim
 * `<A-e>` or `<A-p>` mapping never fired inside a DevHub terminal: on a US
 * layout Option+E is the dead key for `´` and Option+P is `π`, not `ESC e`
 * and `ESC p`.
 *
 * `true` sends `ESC` and the key for Option with a key — what `<A-…>` and
 * `<M-…>` mappings, readline's `M-b` and tmux's `M-` bindings read — exactly
 * as xterm.js's own `macOptionIsMeta` does. `"left"` does that for the left
 * Option only and leaves the right one composing, which is what iTerm2
 * ("Left Option key: Esc+") and Ghostty (`macos-option-as-alt = left`) offer:
 * both, on one keyboard. Either way Option+¥ (the `IntlYen` key of a Japanese
 * keyboard) still types `\`; see `shell/surfaces/optionKey.ts`.
 *
 * DevHub's terminals only — the Workspace terminal, a pane's terminal and an
 * Agent's. VS Code's integrated terminal reads its own
 * `terminal.integrated.macOptionIsMeta`, which DevHub does not write.
 */
export type MacOptionIsMeta = boolean | "left";

export const DEFAULT_MAC_OPTION_IS_META: MacOptionIsMeta = false;

export function isMacOptionIsMeta(value: unknown): value is MacOptionIsMeta {
  return typeof value === "boolean" || value === "left";
}
