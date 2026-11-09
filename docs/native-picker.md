# Native picker UI (proposal)

Status: proposed, not built; mocked for the person (files, grep and
buffers pickers in the variant-B float style, light and dark), not picked yet.

A picker is drawn today as the plugin's Neovim floats (snacks: an input, a
list and a preview window), which DevHub paints as cells in its float frame
(`neovim-editor.md`, "The page": `floatClusters`, `frameCuts`). What cells
cannot give: rows taller than a line, a file name in the UI face with its
directory after it, matched characters as weight rather than a colour run,
grep hits grouped under their file, flags as words. The idea: keep the
picker's logic — sources, matching, sorting, actions, keymaps — in Neovim,
and let DevHub draw the input and the list natively from the picker's state.

## What the pickers offer

Read at the commits named (cloned 2026-11-09).

- **snacks.nvim** ([882c996], the dotfiles' lock):
  - The list is virtual: `list:render()` writes only the rows from `top`
    for the list window's height into its buffer, each row from
    `list:format(item)` — text plus extmarks whose `hl_group` names the
    role (`SnacksPickerDir`, `SnacksPickerFile`, `SnacksPickerBufNr`,
    `SnacksPickerIcon`…) and `SnacksPickerMatch` on every matched
    character ([list.lua#L467-L548]). `top`, `cursor`, `scrolloff` and the
    page size (`state.height`, the window's height) are the list's state
    ([list.lua#L233-L299], [#L357]). `render()` returns at once without a
    valid window ([#L550]).
  - Layouts are boxes of `input`, `list` and `preview`; `hidden` leaves a
    window out, and its own docs say only `input` and `preview` make sense
    ([defaults.lua#L60], [layout.lua#L33]): without a list window nothing
    renders.
  - `win.<name>` options reach `nvim_open_win` and every later
    `nvim_win_set_config`, `hide` included ([win.lua#L167-L186],
    [#L803-L811]); snacks hides and unhides a layout this way itself
    (`layout:hide()`, used by `pick_win`: [layout.lua#L556-L577],
    [actions.lua#L317]).
  - Callbacks: `on_change(picker, item)` on each move, `on_show`,
    `on_close` ([defaults.lua#L110-L112], [picker.lua#L450-L497],
    [#L633]). The object: `picker:items()`, `:current()`, `:selected()`,
    `:count()`, `picker.list`, `picker.input.filter.{pattern,search}`,
    `picker.preview`, `:action(name)` ([picker.lua#L548-L640], [#L768]).
    Titles are templated (`{title} {live} {flags}`) in `update_titles`
    ([#L384-L446]).
  - The input is a `buftype=prompt` buffer entered in Insert mode; the
    person's `win.input.keys` (the dotfiles' `<C-q>` `send_to_rg`) are its
    buffer-local maps ([input.lua#L22-L60]).
  - The preview fills a scratch buffer (treesitter started on it) or shows
    the real buffer ([preview.lua#L236-L310]).
  - It already replaces `vim.ui.select` ([init.lua#L94]).
- **telescope.nvim** ([1e1bab7]): `create_layout(picker)` builds the
  windows itself ([pickers.lua#L54], [#L329]); entries are written into the
  results buffer, matches as `TelescopeMatching` ranges
  ([#L455-L486]). The same seam as snacks, with less state exposed and the
  plugin in maintenance.
- **mini.pick** ([f1216d7]): the cleanest data API —
  `source.show(buf, items_to_show, query)` ([pick.lua#L366]),
  `get_picker_matches()` (all, current, marked, shown: [#L1677]),
  `MiniPickMatch`/`Start`/`Stop` events ([#L146]) — but one window with the
  prompt in its border, and keys read by a `getcharstr()` loop
  ([#L3689]), not Neovim maps: a native input would have to fake the loop.
- **fzf-lua** ([22f0bbd]): fzf in a `:terminal` ([fzf.lua#L171-L174]);
  matching and the list are an external TUI, there is no item stream inside
  Neovim. No seam short of driving fzf's `--listen` API.
- **Neovim**: a window with `hide = true` exists, can be current and takes
  the keys, its cursor is invisible and it is not redrawn
  ([windows.txt#L79], 0.10+); with `ext_multigrid` it is a `win_hide`.
  `vim.ui.select` gained `preview_item` after 0.12 and `:browse oldfiles`,
  `:recover`, `:tselect` and `z=` now go through it ([lua.txt#L5777],
  [news.txt#L579], [#37360]). There is no UI event for pickers, proposed or
  built: `ext_popupmenu` is completion only; the builtin picker is the
  eleven-year-old [#660], and [#35456] (a unified input concept over
  `ui2`, backlog) names none.

## Options

- **(a) A snacks frontend in devhub.nvim.** Hide the list window (and the
  input) with `hide = true`, keep both alive, and stream snacks' rendered
  state to a native surface. Keys, focus, matching and actions stay
  snacks'; DevHub only draws.
- **(b) Restyle the floats by filetype** (`snacks_picker_list`,
  `TelescopeResults`) without an adapter. Cheap, and DevHub already frames
  the cluster as one panel; but rows stay cells — the ceiling is a
  selection pill and a frame, which is roughly today.
- **(c) `vim.ui.select` only.** Covers code actions, `z=`, `:tselect` (and
  previews after 0.12), and any plugin that calls it; but snacks owns
  files, grep and buffers, and snacks itself takes `vim.ui.select`. Worth
  having later as the generic case, not as the answer.
- **(d) A generic picker surface in `devhub_gui`, fed by per-plugin
  adapters.** (a)'s mechanism split in two: `devhub_gui.picker` knows rows
  (runs with highlight names and match spans, a selected index, counts,
  toggles, key hints) and a preview window; a twenty-line adapter per
  plugin fills it. snacks first; telescope can follow through
  `create_layout`, `vim.ui.select` through a tiny built-in source.

## Proposal: (d), snacks first

```lua
-- devhub.nvim, in DevHub's GUI only (gui.available())
require('devhub').setup{ picker = true }     -- vim.g.devhub_native_picker = false keeps cells
```

The adapter merges into every picker's options (a `config` hook on
`Snacks.picker`, no fork):

- `win.list.hide = true` and `win.input.hide = true`. The layout is the
  person's (`custom_default`: 80 % × 90 %, the preview 45 %), so every
  window keeps its place; the hidden two are simply not drawn.
- **Input.** The prompt buffer stays the current window, in Insert mode:
  every map of the person's and of snacks works as before. On
  `TextChangedI`/`CursorMovedI` Lua sends the line and the cursor's byte
  column; DevHub draws the field (in the grid's face), its caret and an
  IME preedit, as it does the command line.
- **List.** After each `list:render()` (wrapped, or on the list buffer's
  `on_lines`) Lua sends the visible rows as `list:format()` gave them —
  text, runs with highlight names resolved to colours, match spans — with
  `top`, `cursor`, `count()` and the selection. DevHub never matches, sorts
  or scrolls on its own: it draws the rows snacks wrote.
- **Page size.** The hidden window's height is no longer seen, so it is
  the knob for how many items one page holds: DevHub measures how many of
  its rows fit (24 px rows, grep's file headings) and Lua sets the hidden
  window's height (and width, which `format` uses to truncate) to it — the
  `gui.inline` measuring round trip again.
- **Preview.** Stays a Neovim window: treesitter, the real buffer (unsaved
  edits), the target line, folds and diagnostics are Neovim's, and DevHub
  already draws grids well. The native panel is placed round its cells;
  only the header (a breadcrumb, the line) is DevHub's.
- **Mouse.** A click is `list:_move(idx, true)`, a double click
  `confirm`, the wheel `list:scroll`, all over RPC; DevHub waits for the
  next render.
- **Chrome.** The variant-B frame, one panel (input band, list, preview, a
  key-hint row from the input buffer's maps' `desc`). Rows are the
  `SnacksPicker*` roles in DevHub's type: a file's name in the UI face and
  its directory after it, matched characters bold, grep hits grouped under
  their file (a heading DevHub adds above a run of one file's items: not
  an item, so `j`/`k` never stop on it), buffer flags as words.
- **Degrading.** Outside DevHub nothing is installed. Any error in the
  adapter, or a picker whose layout has no list (`hidden`), takes the
  `hide` off: the person's snacks as cells, framed as today.

Wrinkles found in the source: `pick_win` (and anything calling
`layout:unhide()`) sets `hide = false` on every window, so the adapter puts
its two back on `on_update`; `layout.preview = 'main'` and split layouts
(`sidebar`, the explorer) are left as cells at first.

## Why this over the rest

It is the only option that keeps the person's snacks setup — sources,
`layouts`, `<C-q>`, `resume` — with zero porting, while removing the cell
grid from the two parts that read worst as cells (the list and the input).
It follows the editor's rule: Neovim owns state, layout and keys; DevHub
paints data. Its seam is public API plus Neovim's own `hide`, not a fork;
the generic surface (d) leaves room for telescope and `vim.ui.select`
without making DevHub know a plugin. (b) is a polish of today; (c) misses
the pickers the person uses; mini.pick and fzf-lua would mean switching
pickers, and fzf-lua cannot be drawn natively at all.

Before building: a spike in a real DevHub with the dotfiles' config to
confirm a hidden current input window keeps Insert mode and IME through
`ext_multigrid`, and that snacks' throttled `render()` is not starved
while its list window is not redrawn.

[882c996]: https://github.com/folke/snacks.nvim/tree/882c996cf28183f4d63640de0b4c02ec886d01f2
[list.lua#L467-L548]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/list.lua#L467-L548
[list.lua#L233-L299]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/list.lua#L233-L299
[#L357]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/list.lua#L357
[#L550]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/list.lua#L550
[defaults.lua#L60]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/config/defaults.lua#L60
[defaults.lua#L110-L112]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/config/defaults.lua#L110-L112
[layout.lua#L33]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/layout.lua#L33
[layout.lua#L556-L577]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/layout.lua#L556-L577
[win.lua#L167-L186]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/win.lua#L167-L186
[#L803-L811]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/win.lua#L803-L811
[actions.lua#L317]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/actions.lua#L317
[picker.lua#L450-L497]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L450-L497
[#L633]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L633
[picker.lua#L548-L640]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L548-L640
[#L768]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L768
[#L384-L446]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L384-L446
[input.lua#L22-L60]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/input.lua#L22-L60
[preview.lua#L236-L310]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/preview.lua#L236-L310
[init.lua#L94]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/init.lua#L94
[1e1bab7]: https://github.com/nvim-telescope/telescope.nvim/tree/1e1bab730218eaf97fce743be3f56e51075928ac
[pickers.lua#L54]: https://github.com/nvim-telescope/telescope.nvim/blob/1e1bab730218eaf97fce743be3f56e51075928ac/lua/telescope/pickers.lua#L54
[#L329]: https://github.com/nvim-telescope/telescope.nvim/blob/1e1bab730218eaf97fce743be3f56e51075928ac/lua/telescope/pickers.lua#L329
[#L455-L486]: https://github.com/nvim-telescope/telescope.nvim/blob/1e1bab730218eaf97fce743be3f56e51075928ac/lua/telescope/pickers.lua#L455-L486
[f1216d7]: https://github.com/echasnovski/mini.pick/tree/f1216d764d0c2772e88d4e1a0cef3082f5b498e1
[pick.lua#L366]: https://github.com/echasnovski/mini.pick/blob/f1216d764d0c2772e88d4e1a0cef3082f5b498e1/lua/mini/pick.lua#L366
[#L1677]: https://github.com/echasnovski/mini.pick/blob/f1216d764d0c2772e88d4e1a0cef3082f5b498e1/lua/mini/pick.lua#L1677
[#L146]: https://github.com/echasnovski/mini.pick/blob/f1216d764d0c2772e88d4e1a0cef3082f5b498e1/lua/mini/pick.lua#L146
[#L3689]: https://github.com/echasnovski/mini.pick/blob/f1216d764d0c2772e88d4e1a0cef3082f5b498e1/lua/mini/pick.lua#L3689
[22f0bbd]: https://github.com/ibhagwan/fzf-lua/tree/22f0bbd3140a8a3b34fec75e5a640513ca6d4ce3
[fzf.lua#L171-L174]: https://github.com/ibhagwan/fzf-lua/blob/22f0bbd3140a8a3b34fec75e5a640513ca6d4ce3/lua/fzf-lua/fzf.lua#L171-L174
[windows.txt#L79]: https://github.com/neovim/neovim/blob/5e149d5200134db18e9e0a997d05c509aabdd8e4/runtime/doc/windows.txt#L79
[lua.txt#L5777]: https://github.com/neovim/neovim/blob/5e149d5200134db18e9e0a997d05c509aabdd8e4/runtime/doc/lua.txt#L5777
[news.txt#L579]: https://github.com/neovim/neovim/blob/5e149d5200134db18e9e0a997d05c509aabdd8e4/runtime/doc/news.txt#L579
[#37360]: https://github.com/neovim/neovim/pull/37360
[#660]: https://github.com/neovim/neovim/issues/660
[#35456]: https://github.com/neovim/neovim/issues/35456
