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
