# Pickers: the quick pick and the editor's picker

Status: tier 2 built (the quick pick for `vim.ui.select`/`vim.ui.input`,
behind devhub.nvim's `quick_pick`, and tmux's choosers in the quick pick's
look); tier 1 built (below, "Tier 1 as built"): DevHub's picker-agnostic
framed `gui.view`, and snacks drawn as one by the `snacks-ui.devhub`
plugin, opt-in.
The rich picker's look is the mock of round 1 (files, grep, buffers,
variant-B floats, light and dark).

## Two tiers

Every "which one?" in DevHub is one of two things, and each gets one UI:

1. **The editor's picker** — snacks (or an equivalent): files, grep,
   buffers, LSP locations. It carries far more than a choice: a preview,
   counts, toggles, source-specific columns, match positions, multi-select,
   the person's own keys and actions. It gets a rich native UI of its own,
   drawn by DevHub from Neovim buffers whose logic stays snacks' (below,
   "Tier 1"). Forcing it into the quick pick would lose what it is for.
2. **Everything simple is DevHub's quick pick** — the command palette's
   control, `Picker` (`shell/components/shell/Picker.tsx`, "the rule": every
   question that takes a choice among options, or one line of typing, is
   this control). Neovim's `vim.ui.select` and `vim.ui.input`, tmux's
   `choose-tree`/`choose-window`/`choose-session`/`find-window` in control
   mode, and DevHub's own questions (workspaces, commands, themes, Agents,
   confirmations) — which already were — use it.

## Tier 2: the quick pick

One look and one keyboard model, whoever asks: a header band (what is
asked, and why), a search field, ranked rows, Return chooses, Escape
cancels, the arrows and `C-n`/`C-p` move. `PickerParts.tsx` holds the
pieces (`PickerHeader`, `PickerSearchGlyph`, `PickerRowText`); `Picker` is
drawn from them, and so is anything that draws the quick pick for state
that is not its own.

### `vim.ui.select` and `vim.ui.input`

```
Lua: vim.ui.select(items, opts, on_choice)          (devhub_gui.select)
  └ gui event "quick_pick" {id, title, question, rows | input}
     └ the Neovim page ─ NEOVIM_CHANNELS.quickPick ─▶ main: picker.ask()
                                                       └ modal "quick-pick" (QuickPickSheet → Picker)
     ◀─ answer (index | text | -1) ─ page ─ nvim_exec_lua devhub_gui._quick_pick_done(id, answer)
  └ on_choice(item, idx) / on_confirm(text), scheduled; nil on Escape
```

- **Neovim does not wait.** No `rpcrequest`: the editor stays live behind
  the sheet and the caller goes on from its callback, as `vim.ui.select`'s
  contract already says it may. A second question replaces the first (one
  quick pick at a time; the first is answered `nil`).
- **Rows** are `format_item`'s text; the matching is the quick pick's own
  scorer (`model/fuzzy.ts`), as for every DevHub question. An input is the
  rule's line of typing: the field starts with `default`, and the one row
  means what was typed.
- **Opt-in.** devhub.nvim's `setup{ quick_pick = true }` makes
  `vim.ui.select`/`vim.ui.input` these (`gui.quick_pick()`); off by
  default until the person approves. `devhub_gui.select`/`input` exist in
  every DevHub-drawn Neovim and do nothing until called.
- **Precedence.** snacks (`picker.ui_select`) and dressing replace
  `vim.ui.select` in their own setup, which may run after devhub.nvim's.
  With `quick_pick` on, devhub.nvim installs again on `VimEnter` and at
  every attach (`User DevhubGui`), so in DevHub's GUI DevHub's wins: a
  simple choice is DevHub's question, drawn as every other one. What it
  replaced is kept and used outside DevHub (a terminal's Neovim, an SSH
  TUI), so the person's snacks `ui_select` is still what they get there.
- **`preview_item`** (after 0.12) is not drawn yet: the quick pick's `aside`
  could hold the preview buffer's lines in their highlights (as a popup's
  code is drawn); a select with a preview is closer to tier 1, so it waits
  for that.

### tmux's choosers

`choose-tree`, `choose-window` (`-w`), `choose-session` (`-s`) and
`find-window` stay what `docs/terminal-mode.md` says: tmux's semantics,
kept in the pty host (`ptyHost/control/chooser.ts`) — the tree, the filter,
which rows are open, what each key does, the template run on Enter. Only
the drawing changed: `ChooserSheet.tsx` draws the rows the pty host sends
with the quick pick's parts (header band, search field showing the filter,
rows with the disclosure, "current" as the accessory), in the place tmux's
box gives it. The chosen pane is still the painter's grid; the pty host
puts it `CHOOSER_HEAD_ROWS` (3) under the box's top so the header and the
field have whole rows: the header a title band one row tall, the title and
its sentence on one line in the bands' type (`PickerHeader`'s `row`, as every
floating surface's title band is), the field two. No key and no command changed.

It is mounted in the terminal page, not on the modal layer, because the
preview is a live grid the terminal's painter draws and the keys are routed
to the pty host by the terminal (control mode has no Neovim to own them).

`display-menu` stays a menu: its items are chosen by their own letters and
it opens at the mouse, a pane or the status line (`-x`/`-y`) — a menu, not
a question with a filter. The quick pick would take its letters for the
filter.

### Keys: the asymmetry

The quick pick is DevHub UI, not a Neovim buffer. Its keys are DevHub's one
model (type to filter, arrows, `C-n`/`C-p`, Return, Escape) for every
question, wherever it came from — so a `vim.ui.select` does not see the
person's Neovim maps, as Neovim's own `confirm()` does not. That is the
point of tier 2: muscle memory for simple questions does not depend on who
asked. tmux's choosers keep tmux's keys, routed to the pty host by the
terminal, because tmux decides there. Tier 1 is the other way round: the
editor's picker is Neovim's, so its keys are Neovim's (below).

## Tier 1 as built

- **DevHub** knows no picker. A `gui.view` (`neovim-editor.md`) given a
  `frame` is drawn in a frame over a float rather than over its window: its
  items (a buffer line per row, the cursor line the selection) in the
  hidden list window's cells, round them a query window (its first line the
  field, the caret where its cursor is in Insert mode), a preview window
  (cells) with a title above it, a header and the view's `keys` as the hint
  row. The plugin lays the windows out; the frame is drawn where they stand.
- **snacks** is drawn as one by
  [snacks-ui.devhub](https://github.com/statiolake/snacks-ui.devhub), a
  plugin outside DevHub and devhub.nvim (DevHub-only plugins are named
  `.devhub`, as Neovim's are `.nvim`). It hooks `Picker.new` (snacks'
  `config` hook) and, in DevHub's GUI only, gives each picker a layout of
  the person's size (`custom_default`'s width, height and preview share)
  whose input and list windows are hidden and borderless and the preview a
  row down, and draws its list's buffer as a framed view. Everything else
  is snacks': the input is its prompt buffer in Insert mode and its
  `win.input.keys` its buffer-local maps (`<C-q>` →
  `send_to_rg` included), the list its buffer of `list:format()` rows,
  matching, actions, history and resume. Rows are read back from the list
  buffer's extmarks by role (`SnacksPickerFile`, `SnacksPickerDir`,
  `SnacksPickerMatch`, …): a file's name first in the UI face with its
  directory after, matches bold, grep's hits under a heading per file,
  buffers' `%`/`#`/`+` as words.
- **What changed from the design below.** snacks' own windows are kept
  (hidden) rather than a headless picker with windows of the frontend's
  own: with `hide = true` snacks needs no replacement for its events, keys,
  resize and actions, and the windows are not kept in sync with anything —
  the frame is drawn where they stand. A hidden float's screen position is
  not kept by Neovim, so `devhub_gui` works it out from its config.
- **Opt-in and fallback.** `require('snacks-ui').setup{ enabled = true }`
  (or `vim.g.snacks_ui_devhub`); outside DevHub's GUI, with a layout that
  is not one group of floats (sidebar, ivy, a preview in the main window),
  or on an error, snacks draws itself unchanged.

## Tier 1: the editor's picker (design)

The person's decisions (round 2): no hidden snacks windows to keep in sync;
snacks' logic driven as a library from a DevHub-owned frontend; panels
backed by real Neovim buffers that take keys in Normal mode, as `gui.view`
and `gui.webview{ keyboard = 'neovim' }` do; the query a text field (Insert
mode); the person's snacks keys as plain buffer-local maps.

### Headless snacks

Read at [882c996] (the dotfiles' lock). A `Snacks.picker` object can live
without ever opening a window:

- `require('snacks.picker.core.picker').new(opts)` with `find = false`
  builds the finder, matcher, list, input, preview and layout objects; a
  `Snacks.win` made with `show = false` opens no window and makes no buffer
  ([win.lua#L252], `show` at L327), and the layout is made `show = false`
  too. Nothing opens until `picker:show()`, which the adapter replaces on
  the instance (`__newindex` is a `rawset`: [picker.lua#L43-L58]).
- The query is `picker.input.filter.pattern` (or `.search` for a live
  source) followed by `picker:find({ refresh = false })`, which is exactly
  what snacks' own `TextChangedI` does ([input.lua#L62-L91]).
- Results arrive through `picker.list` (`count()`, `get(i)`, `cursor`,
  `_move(i, true)`); every change goes through `list:render()`, which
  returns at once without a valid window ([list.lua#L550]) — the one funnel
  the adapter replaces with its own redraw.
- A row is `list:format(item)`: text, and extmarks whose `hl_group` names
  the role (`SnacksPickerDir`, `SnacksPickerFile`, `SnacksPickerMatch` on
  every matched character); it asks the window's width
  ([list.lua#L467-L518]), so the adapter lends it the list window's id.
- Keys are data: each `Snacks.win` normalises its `keys` into `win.keys`
  (`{ lhs, rhs, mode, desc }`, [win.lua#L273-L312]), and
  `picker.input.win:execute(name)` runs an action with no window
  ([win.lua#L340-L372]). Actions read state, not windows: `confirm`/`jump`
  use `picker:selected()` and `picker.main` ([actions.lua#L35-L60]); the
  dotfiles' `send_to_rg` reads `picker.input.filter.search` and closes.

### The frontend

```lua
-- devhub.nvim: lua/devhub/picker.lua (a sketch)
local P = require('devhub').picker
P.open(source, opts)        -- source: 'files' | 'grep' | … | a snacks opts table
-- with setup{ picker = true }, Snacks.picker.pick is routed here in DevHub's GUI,
-- so <C-e>/<C-f>/<C-t> and lib/grep.lua's opts need no change.

-- What it makes (all real buffers, in floats DevHub draws itself):
--   query buffer   one line, Insert mode; DevHub draws it as the field
--   list buffer    one line per item (text + extmarks from list:format),
--                  cursor line = the selection; DevHub paints it natively
--                  (rows, icons, match weight, grouping), as gui.view does
--   preview        a Neovim window (scratch buffer with treesitter, or the
--                  item's own buffer), drawn as cells
-- and devhub_gui.picker{ id, query = qwin, list = lwin, preview = pwin,
--   title, counts, toggles, keys = { { '<CR>', 'open' }, … } }
-- tells the page which windows make up the panel and what to draw round them.
```

- **Opens in Insert mode on the query**, as snacks does: the first thing a
  person does in a file picker is type. `<Esc>` leaves Insert mode into the
  list (Normal mode); `i`/`a`/`I`/`A` there go back to the field. `<Esc>`
  or `q` in the list closes.
- **Keys are buffer-local maps.** `picker.input.win.keys` become Insert-mode
  maps on the query buffer and `picker.list.win.keys` Normal-mode maps on
  the list buffer; an action's rhs is `picker.input.win:execute(action)`,
  a function's is called with the snacks window as snacks does. So the
  dotfiles' `<C-q>` → `send_to_rg` is an Insert-mode map on the query and
  works as before. List motions (`list_down`/`up`/`top`/`bottom`,
  `toggle_focus` on `/`) are left to Neovim's own `j`/`k`/`gg`/`G`/`/`,
  counts included; `CursorMoved` on the list tells snacks
  (`list:_move(lnum, true)`). In the query, `list_down` etc. move the list
  window's cursor.
- **The list buffer is a page of items** (the first few hundred matched),
  rewritten as the matcher reports; DevHub does no matching. Its lines and
  extmarks alone are a usable picker in a plain Neovim, so outside DevHub
  the same frontend runs as ordinary floats (or the adapter is not
  installed and snacks draws itself).
- **The preview stays a Neovim window**: it is an editor's view of a file —
  treesitter, the real buffer with unsaved edits, folds, diagnostics — which
  DevHub already draws well; drawing code natively would mean a second
  highlighter that disagrees with the colorscheme.

### Risks

- Actions that assume snacks' windows — `cycle_win`, `toggle_preview`,
  `layout_*`, `toggle_maximize`, `preview_scroll_*`, `insert_*` (they write
  into `input.win.buf`), `toggle_help_*` — need the adapter's own versions
  or are left unmapped. Others' sources may add more.
- `list:format` reads the window's width for `resolve` (truncation): the
  adapter lends `list.win.win` for the call only, or a later snacks may read
  more of the window.
- snacks' internals (`list.render`, `list._move`, `win.keys`) are not its
  public API; a snacks update can move them. The adapter pins to what it
  checks (`pcall`, a version check) and falls back to snacks' own UI.
- Insert mode in a buffer DevHub draws as a field: the caret and an IME's
  preedit must be drawn in the field (as the command line draws them), not
  at the hidden cell.

### Spike plan

1. devhub.nvim `picker.lua`: headless `files` with the dotfiles' config —
   query buffer, list buffer, preview window as plain floats (no DevHub
   drawing yet); `<CR>` and `<C-v>` open, `<Esc>`/`q` close; check
   `Snacks.picker.resume()` and history still work.
2. `grep` with `lib/grep.lua`'s opts: live search, `<C-q>` → `send_to_rg`.
3. DevHub: `devhub_gui.picker` and the page's panel (the mock's rows over
   the list window, the field over the query window, the frame round all
   three); checked in the app with the dotfiles' config.
4. `buffers`, `lsp_references`, multi-select (`<Tab>`), then the person
   picks whether `Snacks.picker.pick` is routed by default.

## Extension points (round 1)

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

[win.lua#L252]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/win.lua#L252
[picker.lua#L43-L58]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/picker.lua#L43-L58
[input.lua#L62-L91]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/input.lua#L62-L91
[list.lua#L467-L518]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/core/list.lua#L467-L518
[win.lua#L273-L312]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/win.lua#L273-L312
[win.lua#L340-L372]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/win.lua#L340-L372
[actions.lua#L35-L60]: https://github.com/folke/snacks.nvim/blob/882c996cf28183f4d63640de0b4c02ec886d01f2/lua/snacks/picker/actions.lua#L35-L60
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
