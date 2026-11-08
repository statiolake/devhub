/**
 * The built-in themes that have a Neovim colorscheme of their own: made by
 * the same authors as the terminal palette DevHub wears under that name, so
 * the editor looks as they meant it — syntax roles, UI, plugin groups —
 * rather than as DevHub's generator guesses from sixteen colours.
 *
 * A theme is listed only where its palette and the plugin's are the same
 * one: the background, the foreground and the eight normal ANSI colours
 * were compared against the plugin's own source (its palette file, or the
 * Ghostty / iTerm2 extras it ships). A variant the plugin has no
 * colorscheme for (Gruvbox's hard contrast, which is a `setup()` option) is
 * left to the generator.
 *
 * Where the plugin is not installed, DevHub wears the generated colorscheme
 * and says once which plugin would be worn (`docs/themes.md`, "Neovim").
 */

/** The colorscheme a theme is meant to be worn as in Neovim. */
export interface NeovimPlugin {
  /** What `:colorscheme` takes, e.g. `tokyonight-night`. */
  readonly colorscheme: string;
  /** The plugin that provides it, as `owner/repo` on GitHub. */
  readonly plugin: string;
}

const TOKYONIGHT = "folke/tokyonight.nvim";
const CATPPUCCIN = "catppuccin/nvim";
const KANAGAWA = "rebelot/kanagawa.nvim";
const ROSE_PINE = "rose-pine/neovim";
const GRUVBOX = "ellisonleao/gruvbox.nvim";
const NIGHTFOX = "EdenEast/nightfox.nvim";
const VSCODE_2026 = "statiolake/vscode-2026-theme.nvim";

/** By theme name, as the catalog spells it. */
export const NEOVIM_PLUGINS: Readonly<Record<string, NeovimPlugin>> = {
  // VS Code's 2026 themes, which DevHub's own two take their terminal
  // colours from.
  "DevHub Dark": { colorscheme: "vscode-2026-dark", plugin: VSCODE_2026 },
  "DevHub Light": { colorscheme: "vscode-2026-light", plugin: VSCODE_2026 },
  // "TokyoNight" is the Night palette with a different selection colour.
  TokyoNight: { colorscheme: "tokyonight-night", plugin: TOKYONIGHT },
  "TokyoNight Night": { colorscheme: "tokyonight-night", plugin: TOKYONIGHT },
  "TokyoNight Storm": { colorscheme: "tokyonight-storm", plugin: TOKYONIGHT },
  "TokyoNight Moon": { colorscheme: "tokyonight-moon", plugin: TOKYONIGHT },
  "TokyoNight Day": { colorscheme: "tokyonight-day", plugin: TOKYONIGHT },
  "Catppuccin Mocha": { colorscheme: "catppuccin-mocha", plugin: CATPPUCCIN },
  "Catppuccin Macchiato": {
    colorscheme: "catppuccin-macchiato",
    plugin: CATPPUCCIN,
  },
  "Catppuccin Frappe": { colorscheme: "catppuccin-frappe", plugin: CATPPUCCIN },
  "Catppuccin Latte": { colorscheme: "catppuccin-latte", plugin: CATPPUCCIN },
  "Kanagawa Wave": { colorscheme: "kanagawa-wave", plugin: KANAGAWA },
  "Kanagawa Dragon": { colorscheme: "kanagawa-dragon", plugin: KANAGAWA },
  "Rose Pine": { colorscheme: "rose-pine-main", plugin: ROSE_PINE },
  "Rose Pine Moon": { colorscheme: "rose-pine-moon", plugin: ROSE_PINE },
  "Rose Pine Dawn": { colorscheme: "rose-pine-dawn", plugin: ROSE_PINE },
  // One colorscheme for both; it follows 'background', which DevHub sets
  // from the theme before naming it.
  "Gruvbox Dark": { colorscheme: "gruvbox", plugin: GRUVBOX },
  "Gruvbox Light": { colorscheme: "gruvbox", plugin: GRUVBOX },
  Nightfox: { colorscheme: "nightfox", plugin: NIGHTFOX },
};
