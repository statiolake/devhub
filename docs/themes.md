# Colour themes

DevHub's colours are its own. A theme is a terminal palette, the way Ghostty's
are — sixteen ANSI colours, the background and foreground, the cursor and the
text under it, the selection — and everything DevHub paints is derived from
the one the settings select: the window and every page, the terminals, and
the Neovims DevHub draws. VS Code is not asked; with `editor = "vscode"` a
workbench wears whatever its own `settings.json` names.

## Choosing one

```toml
[appearance]
theme = "Catppuccin Mocha"                                  # both appearances
theme = "light:Catppuccin Latte,dark:Catppuccin Mocha"      # one each
```

`light:<name>,dark:<name>` is Ghostty's spelling, in either order; the half is
picked by the appearance DevHub is in (`appearance.mode`: `auto` follows
macOS). A name matches exactly, else ignoring case. A name no theme has is said
once (a notice) and DevHub's own theme is worn for that half. The default is
`light:DevHub Light,dark:DevHub Dark`.

A change to the file applies at once: the window, the terminals and the
Neovims are recoloured live. **Theme: Preview…** (the command palette, or
Settings ▸ General ▸ Appearance ▸ Preview Themes…) lists every theme and wears
the one under the cursor while the list is open; Return keeps it for the
session and Escape goes back. It writes nothing: `settings.toml` stays the
source of truth, and the next save, Reload or restart wears what it says.

## Built in

- **DevHub Dark** and **DevHub Light**: the terminal colours of VS Code's
  "Dark 2026" and "Light 2026", which were DevHub's defaults before its themes
  were its own (`model/themes/devhubThemes.ts`).
- **The collection**: 267 themes from
  [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes),
  the collection Ghostty ships, at a pinned commit
  (`model/themes/builtinThemes.generated.ts`, about 48 KB). The collection is
  MIT; each theme's copyright is its author's, and the collection records each
  theme's licence in `licenses.yml`. Only the permissively licensed ones are
  bundled — MIT, Apache-2.0, ISC, CC0, WTFPL, Zlib, Unlicense, 0BSD. The 594
  marked `unknown`, the 18 `nonfree` and the 28 under a copyleft licence (GPL,
  LGPL, CC-BY-SA) are left out.
  `distribution/licenses/iTerm2-Color-Schemes.txt`, which ships in the app's
  `Resources/licenses`, lists every bundled theme with its licence and source.

To refresh the collection, check out iTerm2-Color-Schemes (only `ghostty/`,
`licenses.yml` and `LICENSE` are read) and run

```sh
node apps/desktop/scripts/import-terminal-themes.mjs <checkout>
```

which rewrites the generated table and that licence file. Nothing is fetched at
runtime.

## Your own

```toml
[themes."My Theme"]
background = "#1e1e2e"
foreground = "#cdd6f4"
cursor = "#f5e0dc"                 # optional: the foreground
cursor_text = "#1e1e2e"            # optional: the background
selection_background = "#585b70"   # optional: a quarter from background to foreground
selection_foreground = "#cdd6f4"   # optional: a selected cell keeps its colour
palette = [                        # ANSI 0–15: black, red, green, yellow, blue,
  "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",   # magenta, cyan, white, then
  "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",   # the bright eight
  "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
  "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
]
```

and name it in `[appearance] theme`. One named like a built-in theme replaces
it. A table DevHub cannot use is refused with its path, as any setting is
(DevHub keeps running on the last settings it accepted): a colour that is not
`#rrggbb` / `#rgb`, a palette that is not exactly sixteen colours, a key it
does not know, a missing `background`, `foreground` or `palette`, or a name
`appearance.theme` could not spell (one with a comma, or starting `light:` /
`dark:`).

## What is derived from it

**The window and pages** (`shellPaletteOfTheme`):

| Token       | From                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`   | the background: content sits on the same ground as the terminal beside it                                                                            |
| `chrome`    | the background 0.03 darker in OKLCH lightness (lighter on a ground already near black): the Sidebar and title band, a frame rather than a second hue |
| `canvas`    | the same as `chrome`                                                                                                                                 |
| `ink`       | the foreground                                                                                                                                       |
| `accent`    | blue — ANSI 4, or 12 when it reads better — lifted to 4.5:1 on the ground if it must be, since the accent is mostly read as ink                      |
| `accentInk` | whichever of the background and the foreground holds more contrast on the accent                                                                     |

Everything else (hairlines, washes, raised and sunken surfaces, status
colours) is derived from those in `tokens.css`, as before.

**The terminals**: the theme's colours as they are.

**The programs in the terminals**: the theme is published as before
(`DEVHUB_THEME`, `DEVHUB_FZF_COLORS`, `~/.local/state/devhub/theme.json`,
`User DevhubTheme`; [window-and-pages.md](window-and-pages.md), "Terminal
programs").

**The Neovims DevHub draws**: a colorscheme generated from the theme
(`model/themes/neovimColorscheme.ts`), below.

## Neovim

### How it is worn

DevHub applies the colorscheme, named `devhub`, to every Neovim it draws — the
managed one and each terminal's `nvim` — when it attaches and again on every
theme change, **unless the person's config has chosen another colorscheme**
(`g:colors_name` set to anything but `devhub`). A `colorscheme tokyonight` in
your config wins and is never painted over; with none, or with devhub.nvim's
own `devhub`, DevHub's is worn. It is applied the way a colorscheme file
applies itself (`highlight clear`, `background`, every group,
`g:terminal_color_0`…`15`, `g:colors_name = 'devhub'`) and ends with the
`ColorScheme` event, so your `ColorScheme` autocommands (a status line built
from `StatusLine`, `hi link FloatBorder NormalFloat`) run on it as on any
other. It runs after `User DevhubTheme`, so a plugin that recolours on that
event is drawn over.

Why not opt-in (`colorscheme devhub` in your config)? A Neovim DevHub draws
should match the window around it without configuration, the way the terminal
does; and a config that already names a colorscheme keeps it. Why not a
`colors/devhub.lua` file? A Neovim on an SSH host has no DevHub files; the
table travels over the RPC socket DevHub already holds. The same table is in
`theme.json` (`neovim`), so a Neovim DevHub does not draw can apply it too.

### Roles

Reference schemes, read from their source: Neovim's default (0.10+,
`highlight_group.c`) and its `vim` colorscheme, tokyonight, catppuccin,
kanagawa, gruvbox (ellisonleao), onedark (navarasu), nightfox, base16 (RRethy's
base16-nvim and mini.base16) and mini.hues. "n/9" counts the nine families.

| Role                   | From                                                                       | Why                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| keyword                | magenta (5)                                                                | 6/9: tokyonight, catppuccin, kanagawa, onedark, nightfox, base16. gruvbox is red; Neovim and mini.hues use the foreground in bold                                  |
| function               | blue (4)                                                                   | 7/9; gruvbox green, Neovim cyan                                                                                                                                    |
| type                   | yellow (3)                                                                 | 5/9: catppuccin, onedark, gruvbox, nightfox, base16                                                                                                                |
| string                 | green (2)                                                                  | 9/9                                                                                                                                                                |
| constant, number       | orange, made half-way between red and yellow in OKLCH                      | 6/9 use an orange; ANSI has none                                                                                                                                   |
| special                | cyan (6): escapes, regexps, built-in types and functions                   | Neovim's default links `@type.builtin`, `@function.builtin` and escapes to `Special`, which it, base16 and mini.hues make cyan                                     |
| variable               | the foreground                                                             | 9/9                                                                                                                                                                |
| field, property        | blue mixed 45% toward the foreground                                       | the families split; blue-ish is the largest group (catppuccin's lavender, nightfox, gruvbox). Mixed so it is not read as a function                                |
| parameter              | red mixed 45% toward the foreground                                        | split again; catppuccin's maroon and onedark's red. Mixed so it is not read as an error                                                                            |
| `self`, `this`         | red (1)                                                                    | tokyonight, catppuccin, onedark, nightfox                                                                                                                          |
| operator, punctuation  | the foreground 25% toward the background                                   | Neovim, mini.hues, nightfox, onedark: the foreground or a quieter grey                                                                                             |
| `Identifier`           | as field                                                                   | Vim's own syntax files (TypeScript's, without Tree-sitter) put `const` / `let` there; Neovim's default and gruvbox make it blue                                    |
| comment                | ANSI 8 (bright black), italic                                              | the terminal's own "dim" colour; italic in tokyonight, catppuccin, kanagawa, gruvbox. The foreground half-way to the background when ANSI 8 is not between the two |
| line numbers           | the comment 30% toward the background                                      | quieter than comments, as every family has them                                                                                                                    |
| floats, menu           | the background 0.035 toward its edge (darker when dark)                    | where Neovim's default, tokyonight, catppuccin and mini.hues put floats; toward the foreground (7%) when the background is already black or white                  |
| cursor line            | background → foreground, 7% (OKLab)                                        | a step without a new hue, mini.hues' `bg_mid` idea                                                                                                                 |
| status line            | 13%                                                                        |                                                                                                                                                                    |
| matching bracket       | 20%, bold                                                                  | Neovim's default: a grey ground, bold                                                                                                                              |
| Visual, menu selection | the theme's selection; else the ground tinted toward a bluish foreground   | a terminal's selection may assume the text is recoloured (Catppuccin's is); used only when the foreground reads on it at 3.5:1                                     |
| search                 | yellow mixed 30% into the ground, the text kept                            | yellow in Neovim, gruvbox, onedark, base16                                                                                                                         |
| current match          | orange, filled, the ground as ink, bold                                    | tokyonight, onedark, gruvbox, base16                                                                                                                               |
| diagnostics            | error red, warn yellow, info cyan, hint blue, ok green                     | Neovim's default levels. Virtual text on its colour mixed 10% into the ground (tokyonight, catppuccin); undercurl with `sp`                                        |
| diffs                  | green / red / blue mixed 18% / 14% / 12% into the ground; changed text 30% | backgrounds, so the syntax stays; tokyonight's tints                                                                                                               |

Every text role reaches 4.5:1 on the background (WCAG AA), comments 3:1,
line numbers 2.2:1: a colour that does not is moved in lightness only, hue and
chroma kept, and a theme's own colour that reads is never touched. For each
hue the normal ANSI colour is taken when it reads, else the bright one. A slot
with no hue in a theme whose others have one, or a copy of an earlier slot, is given its canonical hue at the
theme's typical lightness and chroma. A theme that is grey throughout stays
grey, and keywords are told by weight instead.

### Groups

Every group a colorscheme usually sets, most as links so overriding one group
carries to the rest: the editor (`Normal`, floats, `Pmenu*`, `StatusLine*`,
`WinSeparator`, `CursorLine`, `Visual`, `Search`, `CurSearch`, `MatchParen`,
`LineNr`, `Folded`, `NonText`, …), legacy syntax, the Tree-sitter captures
that should not simply be their legacy group (`@variable*`, `@property`,
`@type.builtin`, `@markup.*`, `@diff.*`, `@tag*`, …), LSP semantic tokens
where Neovim's default links fall short (`@lsp.type.variable` cleared so
Tree-sitter's finer captures show, `defaultLibrary` to the built-in captures,
`unresolvedReference` as an error undercurl), diagnostics, diffs, and
gitsigns, blink.cmp, snacks, fidget and nvim-tree. The full table is
`neovimColorscheme()`.
