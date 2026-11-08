# The Neovim editor: DevHub as a GUI for Neovim

With `[general] editor = "neovim"` a Workspace's editor area is not a VS Code
workbench but DevHub's own GUI for a Neovim: a headless `nvim` on the
Workspace's machine, drawn by DevHub through Neovim's UI protocol. Neovim owns
the buffers, the windows and their layout, the modes, the plugins and the
language servers; DevHub draws, and adds GUI-native widgets that are attached
to Neovim objects and follow them.

```toml
[general]
editor = "neovim"   # "vscode" (the default): each Workspace's own VS Code
```

Settings > General > Editors > Editor is the same switch. It applies at once:
with "neovim" no workbench is started for any Workspace (the lifecycle plan
wants none, `planWorkbenches`), and one that was running is closed; back to
"vscode", the Neovim pages are taken away and the workbenches start as before
(on Enter, or a file opened into them). The VS Code path is untouched.

## Architecture

```
 neovim.html (one view per Workspace)            main                    the Workspace's machine
 ┌───────────────────────────────┐      ┌─────────────────────┐      ┌──────────────────────────┐
 │ redraw.ts  (pure reducer)     │◀─────│ NeovimEditors       │◀─────│ nvim --headless --listen │
 │ painter.ts (a canvas per grid)│redraw│  NeovimUi (attach,  │ rpc  │   kept by a hidden tmux  │
 │ widgets: pum, cmdline, tabs,  │─────▶│  clipboard, GUI     │─────▶│   window (new-window -d) │
 │  GUI windows (iframe, xterm)  │calls │  windows)           │      │   socket: local, or      │
 │ keys.ts ime.ts mouse.ts       │      │ ManagedNeovims      │      │   ssh -O forward -L      │
 └───────────────────────────────┘      └─────────────────────┘      └──────────────────────────┘
```

### The process

`main/editor/managedNeovim.ts` keeps one Neovim per Workspace:
`env DEVHUB_NEOVIM_GUI=1 nvim --headless --listen <socket>` with the person's
own config, cwd the Workspace's folder, in a window of the Workspace's `ws-`
tmux session made with `new-window -d`, so it is never the window anybody
sees. tmux is only its keeper: the Neovim survives a DevHub restart and an SSH
connection dropping, and the next DevHub adopts it by its socket, which is a
digest of the Workspace id. Nothing from that pane is ever displayed — DevHub
is the server's only UI. (The editor-area terminal view that used to show a
TUI Neovim in a tmux pane is gone.)

- **This Mac**: the socket is in DevHub's own `0700` directory and is
  connected to directly.
- **An SSH host**: the socket is in `${TMPDIR:-/tmp}/devhub-nvim-<uid>/` on the
  host, and is forwarded to a socket here over the host's ControlMaster —
  `ssh -O forward -L <here>:<there>` (`Runtime.forwardUnixSocket`,
  `editor/neovimMachines.ts`). A dropped connection takes the forward with it;
  when its Neovim is still running there, the page says the connection
  dropped and attaches again by itself (0.8 s, 2 s, 5 s, 10 s apart; then a
  Retry button), forwarding again and adopting the same Neovim. A closed
  connection only counts as Neovim ending when its keeper pane is gone or
  dead: before, the drop unlinked the host's socket, so Retry started a
  second Neovim beside the orphaned first.
- **A dev container**: not yet. A Workspace whose editor is attached to a
  container says so ("does not run in a dev container yet").
- **No `nvim`**: the page says which machine lacks it and what to do
  (`brew install neovim`, or install it on the host). DevHub does not deliver
  Neovim to hosts (yet).

### The attach

`main/editor/neovimUi.ts` attaches with `rgb`, `ext_linegrid`,
`ext_multigrid`, `ext_popupmenu`, `ext_cmdline` and `ext_tabline`.
`ext_messages` stays off, on 0.11 too: it is still marked experimental there,
and it hands the GUI every prompt Neovim would otherwise draw and wait on —
the hit-enter prompt, `confirm()`, the swap-file question, `:s///c` — which
a GUI that renders them as toasts has to get exactly right or leave the
person stuck in an invisible prompt. Neovim's own message grid
(`msg_set_pos`, `cmdheight`, `messagesopt`) handles all of them, and a
config's `vim.notify` replacement (fidget, snacks) already draws floats. So
messages stay Neovim's, in its message grid. Before attaching it runs a Lua
snippet (`SETUP_LUA`) that:

- sets `g:devhub_gui` (and the pane has `$DEVHUB_NEOVIM_GUI=1` from the first
  line of the config); `has('gui_running')` is 1 for an RPC UI already;
- points `g:clipboard` at DevHub: `+` and `*` are this Mac's clipboard over
  `rpcrequest`/`rpcnotify` on the UI's channel, so a yank on an SSH host lands
  on the Mac;
- maps the Mac's editing keys unless the person mapped them: `<D-c>` yanks
  the selection (the line in Normal mode) to `+`, `<D-x>` cuts it, `<D-a>`
  selects all, `<D-z>`/`<D-Z>` undo and redo, `<D-s>` writes, `<D-v>` puts
  `+`. DevHub's key router answers Cmd+A/C/X/Z with editing commands on its
  own pages, but not on this one (`editingCommands.ts`): there they reach
  the page as `<D-…>` keys. Cmd+V stays the Edit menu's Paste, which the
  page hands to `nvim_paste` (one undoable change, in any mode). In a
  terminal window Cmd+C copies the terminal's selection, and a GUI window's
  page answers Cmd+C/X/A/Z on its own selection. With nothing selected,
  Cmd+C and Cmd+X take the line (in Normal and Insert mode): an unmapped
  `<D-x>` would reach Neovim as a plain `x`. The Edit menu clicked with the
  mouse does the same: its Copy, Cut, Undo and Redo arrive at the page's
  hidden textarea as `copy`/`cut` events and `historyUndo`/`historyRedo`
  input, which the page sends as `<D-c>`, `<D-x>`, `<D-z>`, `<D-Z>` (Select
  All from the menu does nothing yet). The chords still come first;
- defines the `devhub_gui` Lua module and `:DevhubTerminal`, `:DevhubGuiDemo`,
  `:DevhubImageDemo`; once attached it fires `User DevhubGui`.

**Attaching again** (a reloaded page, a restarted DevHub) needs care: Neovim
keeps its window grids and assumes a new multigrid UI has them too. So the
attach is preceded by a moment attached without multigrid (at another size),
which frees them, and a window Neovim does not place again is placed from the
layout Lua reports. A Neovim stopped at a prompt is let out of it first.

### The page

`shell/neovim/`:

- `redraw.ts` — the pure reducer: `grid_resize/line/clear/destroy/scroll`,
  `grid_cursor_goto`, `win_pos/win_float_pos/win_hide/win_close`,
  `msg_set_pos`, `win_viewport`, `hl_attr_define`, `default_colors_set` (with
  DevHub's theme for `-1`), `mode_info_set/mode_change`, `option_set`,
  `busy_start/stop`, `flush`, and the popupmenu, command line and tab line.
  `layoutGrids` stacks the grids: grid 1, the windows, floats by `zindex`
  against their anchor grid, the message grid on top.
- `painter.ts` — a 2D canvas per grid, repainted a dirty row at a time on
  the animation frame after a `flush`; runs of one highlight, wide characters
  cell by cell, underline/undercurl/underdouble/dotted/dashed/strikethrough in
  the special colour, `reverse`, float `blend`. Floats edge to edge (or a
  cell apart) at about the same `zindex` are one panel — a picker's input,
  list and preview (`floats.ts`'s `floatClusters`): one shadow under the
  union of their outlines (an element of grounds per cluster, under the
  canvases, with a `drop-shadow`), a one-cell seam between them filled with
  their ground, only the panel's outer corners rounded; a float alone is a
  panel of one, and one with `winblend` gets none. A float without a border
  gets DevHub's frame (that shadow, a hairline, rounded corners); one whose
  border is blank cells (`'solid'`, a table of spaces — Neovim 0.10+ says
  where a border is with `win_viewport_margins`) is drawn as with none:
  only its text area, where Neovim put it, in that frame, and a click on
  the left-out border falls through (`GridBox.crop`). One whose border
  draws something (`'rounded'`, `'single'`, …) is drawn as Neovim says,
  with only a shadow: never two frames (`floatBorder`). Ligatures off. The font is `guifont` if set, else DevHub's
  terminal font (Settings > Terminal); `linespace` is honoured.
  - The cell is measured on whole device pixels (crisp at
    `devicePixelRatio` 2; the text of a run is spread to the cell with
    `letterSpacing`), and measured again when the window moves to a screen of
    another density.
  - A float with `winblend` shows what is under it only through its blank
    cells, as Neovim's compositor does; under its text the ground is its
    own background blended into the editor's.
  - Box drawing (U+2500–257F: light, heavy, double, dashed, rounded,
    diagonal and half lines), block elements (U+2580–259F: eighths, halves,
    quadrants, shades) and Powerline's separators (U+E0B0–E0BF: triangles,
    arrows, half circles, slants) are drawn geometrically, not from a font
    (`glyphs.ts`): rectangles on whole device pixels through the whole cell,
    `linespace` included, so window separators, float borders (`rounded`,
    `double`, heavy) and statusline separators join their neighbours like
    native borders at any font and line height. Line thickness grows with
    the font size.
  - Nerd Font icons draw whatever `guifont` is: DevHub bundles Symbols Nerd
    Font Mono (Nerd Fonts 3.5.1, `shell/neovim/fonts/`; MIT and its icon
    sets' own licences, `distribution/licenses/Nerd-Fonts-Symbols-Only.txt`)
    as "DevHub Nerd Symbols", with a `unicode-range` of the Nerd Font code
    points only (the private-use areas and the IEC power symbols), first in
    the font stack of the grids, the command line, the completion menu, the
    tab strip, toasts and popups — it answers for icons and nothing
    else. An icon is fitted to its cell (two when Neovim says it is wide)
    and centred on the text; one followed by a blank cell of the same
    background may spill into it at up to the Nerd Font's own size, as
    kitty and WezTerm draw them, since devicons, lualine and completion
    menus all put a space after their icons. A completion kind that starts
    with an icon (lspkind) shows that icon in the popup menu.
  - A full repaint of a 164×43 screen with two windows and a float takes
    about 6 ms (15 000 cells at `devicePixelRatio` 2: about 4 ms); there is
    no glyph atlas, and none has been needed.
- The cursor follows `guicursor`: its shape, its highlight, and its blink
  (`blinkwait`/`blinkon`/`blinkoff`, restarted on every move). It glides to a
  new cell in 70 ms outside Insert mode (none with reduced motion).
- Each window gets an overlay scrollbar from `win_viewport`, shown while the
  view moves and faded out after.
- A window that scrolls a few rows (0.10+: `win_viewport`'s `scroll_delta`;
  at most a third of its height) slides into place in 90 ms, clipped to its
  own box; a bigger jump (`<C-d>`, `G`) is not animated, nor anything with
  reduced motion.
- `keys.ts` — a `keydown` as key notation: `<C-…>`, `<M-…>` for Option when
  `[terminal] mac_option_is_meta` says it is Meta (left/right tracked as in
  DevHub's terminals), `<D-…>` for Cmd, named keys, `<lt>` and friends.
  Printable keys arrive as text (`ime.ts`). `Cmd+Q` and the chords never get
  here: main's key router takes them first, as for every surface.
- `ime.ts` — the hidden textarea's events as a state machine: the preedit is
  drawn inline at the cursor, underlined, with the caret at its end (Neovim's
  cursor is hidden meanwhile), and only the committed text is sent (once).
  The painter draws the preedit as it draws the grid (a canvas: the grid's
  font, baseline and cell), each character on the cells it will take once
  committed — a wide one on two (`preeditLayout`, East Asian Wide and
  Fullwidth) — so committing moves nothing. The textarea (a pixel wide, one
  unwrapped line, its caret at its left edge) sits after the preedit's last
  cell, so the candidate window opens under the end of the preedit.
  Paste (Cmd+V, the menu) goes to `nvim_paste`.
- `mouse.ts` — `nvim_input_mouse` with the grid under the pointer (floats
  first), drags kept on the press's grid, wheel/trackpad pixels accumulated
  into line steps.
- Resize: the view's size over the cell size, `nvim_ui_try_resize`.
- Focus: `nvim_ui_set_focus` (FocusGained/FocusLost).
- Widgets in DevHub's chrome: the completion menu at its anchor cell (flipped
  above near the bottom, kind icons, scrolls to the selected item, click to
  select), the command line as a palette-like bar (firstc, cursor, special
  char, `cmdline_block` for multiline), and tab pages as a native tab strip
  (click switches via `nvim_set_current_tabpage`).
- The command line bar sits on whole cells in the grid's font, and Neovim is
  told where: `g:ui_cmdline_pos` (`[row, col]`, the convention noice.nvim
  started), which blink.cmp's `:` completion menu reads, so its float opens
  under the bar's text instead of at the bottom where Neovim's own command
  line would be.
- Floats are kept on the screen as Neovim's own compositor keeps them: one
  that would run past the right or bottom edge is moved in.

### GUI windows: GUI surfaces live inside Neovim windows

The rule: Neovim owns layout, state and input; every GUI element is attached
to a Neovim object and follows it.

```lua
local gui = require('devhub_gui')
local w = gui.open{ title = 'Outline', html = '<button>…</button>', win = 'vsplit' }
--                 or url = 'https://…'; win = 'vsplit' | 'split' | 'float' | 'tab' | 'current'
gui.on_message(w, function(msg) … end)   -- the page's devhub.send(msg)
gui.send(w, { kind = 'outline', … })     -- the page's devhub.onMessage(fn)
gui.close(w)
```

In a float with a border (`:DevhubTerminal float`), the content goes inside
the border, whose cells Neovim draws. A GUI window is a scratch buffer (`buftype=nofile`, `filetype=devhub_gui`,
its id in `b:devhub_gui_id`) shown in an ordinary window or float; the page
paints its web content (a sandboxed iframe) exactly over that window's grid.
So `:vsplit`, `<C-w>hjkl`, `<C-w>=`, `:close`, `:q`, `:only` and tab pages
are Neovim's own, and the content follows. When the cursor enters the window
the keyboard goes into the content; `<C-w>` gives it back to Neovim, which
reads the rest of the window command. A click into it makes it Neovim's
current window. Its content is kept in the Lua module, so it outlives a
DevHub restart.

`:DevhubGuiDemo` opens an Outline beside the current window: its buttons jump
that window to a function, or run `gg`, `G`, `:write` in it.

### Notifications and inline images

The same rule, for things smaller than a window. `devhub_gui` sends them as
one-way events on one RPC method (`devhub_gui_event`; main forwards them on
`devhub:neovim:gui-event`; `shell/neovim/decorations.ts` is the page's
reducer, `DecorationViews.tsx` draws them). A payload of the wrong shape is
ignored, so anything odd leaves Neovim's own grid showing; a page that
attaches again is told every image again.

```lua
local gui = require('devhub_gui')          -- or require('devhub').gui (devhub.nvim)
gui.notify{ title = 'Build', msg = 'done', level = 'warn' }   -- a notification
local img = gui.image(0, 5, '~/shot.png', { height_rows = 10 }) -- under line 5
img.clear()
```

- **notify** — fidget-like: compact lines at the bottom right, just above
  the lowest window's status line, under the name of their source
  (`group`), by level (`info`, `warn`, `error`, `debug` or
  `vim.log.levels.*`), fading after 4–8 s (or a click). A `key` updates the
  notification it named in place, so work in progress (`progress = true`,
  `percent`, `done`) spins, shows its percentage and ticks when done (gone
  2 s later). devhub.nvim's `setup{ notify = true }` makes `vim.notify` this
  (its `title` is the source) and shows `LspProgress` (0.10+) the way fidget
  does. Not `ext_messages`: Neovim's messages stay Neovim's.
- **image** — an extmark's `virt_lines` reserve `height_rows` blank rows
  under the line, so Neovim lays them out (the cursor steps over them,
  `:vsplit` shows them twice) and DevHub paints the image there. A path is
  read on Neovim's machine and sent as a `data:` URL (an SSH host's file
  works; 0.10+ for `vim.base64`); an `https:` URL is passed as it is. Where
  it is — the row under the line's last screen row, the text column, from
  the window's top — is worked out again (`screenpos`, `getwininfo`) on
  every `WinScrolled`, `WinResized`, `CursorMoved`, `TextChanged`, window
  open/close and tab change, for every window of the tab page showing the
  buffer; a closed fold hides it, a window's bottom clips it.
  `:DevhubImageDemo [path]` opens a markdown buffer with one (with no path,
  a small generated PNG).

**`:DevhubTerminal`** (`:DevhubTerminal float`) is the same idea: a Neovim
window (a split at the bottom by default) that DevHub fills with the
Workspace's DevHub terminal — its tmux session, on the Workspace's machine. It
is a Neovim window for layout and navigation, and a terminal for input; the
same command toggles it. Keys follow Neovim's own `:terminal`: in the
terminal they all go to the shell, `<C-w>` included (delete-word works);
`<C-\><C-n>` leaves for terminal-normal mode, where the cursor stays in the
window but the keyboard is Neovim's (`<C-w>k`, `:q`, a "TERMINAL NORMAL"
pill says so), and `i`, `a`, `I`, `A`, `<CR>` or a click go back in. Moving
into the window with `<C-w>j` puts the keyboard in the terminal at once. A
`<C-\>` followed by anything else reaches the shell after all.
It wears Neovim's default colours rather than the
terminal theme's, so it reads as part of the editor, and it leaves out the
session's tmux status line — Neovim's statusline is right under it. The
keeper window is started with `$DEVHUB_TMUX` (the tmux that runs the server),
through which `devhub_gui` reads `status` and `status-position`; the terminal
is fitted that many rows taller and those rows are clipped
(`TerminalSurface`'s `hiddenRows`), so the shell keeps every row it shows.

### Components, views, inline cards and decorations

The rule again, for what a plugin wants to show rather than a page: Neovim
owns the state, the layout and the keys; DevHub only paints, and what it
paints is **data**. A config describes content as declarative components
(`shell/neovim/components.ts`: types, the checks a payload passes, and the
layout decisions, pure and unit-tested; `ComponentView.tsx` draws them):
`stack`/`hstack` (gap, padding, alignment, a raised `card`, a left `accent`
bar, a ground, an indent), `text` runs, `markdown` (GFM, fenced code
coloured by the conversation view's highlighter, links opened in the
browser), `badge`, `kbd`, `button`, a tri-state `checkbox`, `progress`, a
Nerd Font `icon`, an `avatar`, `spacer`/`divider`, `sparkline`, a small line
`chart` and an `image`. Every colour is a highlight group's name (or a tone
that names one), resolved by Neovim (`nvim_get_hl`) and sent with the tree,
so a view wears the colorscheme and follows `:colorscheme`. Text is in
DevHub's own (proportional) type, `mono` in the grid's face. There is no HTML
and no script in it: a node with `on_click` gets an action number, and a
click sends that number back to Neovim, where the function runs. A node of
the wrong shape is dropped. `gui.open`'s HTML stays the escape hatch.

The Lua is `main/editor/neovimGuiLayers.ts` (`LAYERS_LUA`), run into
`devhub_gui` at every attach after `SETUP_LUA`; devhub.nvim's `gui.ui` builds
and checks the trees and its `gui.view`/`gui.inline`/`gui.decorate` forward
to it. The page's reducer is `shell/neovim/layers.ts`, its views
`LayerViews.tsx`.

```lua
local gui = require('devhub').gui            -- devhub.nvim
local ui = gui.ui
local view = gui.view{ buf = buf, win = 'vsplit',
  items = function(lnum, line) return ui.hstack{ ui.badge('M', { tone = 'changed' }), ui.text(line) } end,
  on_click = function(lnum) end, keys = { { 'j/k', 'move' }, { '<CR>', 'open' } } }
local card = gui.inline{ buf = 0, lnum = 87, id = 'thread:1', range = { 84, 87 },
  component = ui.card{ accent = 'warn', ui.md('**Waiting** for the agent') } }
local deco = gui.decorate{ buf = 0, range = { 23, 31 }, style = 'dim' }   -- 'highlight' | 'tag'
local pop = gui.popup{ anchor = 'cursor', component = ui.md(markdown), max_width = 80,
  keys = { ['<CR>'] = function(p) end } }                    -- :focus(), :scroll('half'), :close()
```

- **`gui.view`** — a panel that is a buffer: one buffer line per item (the
  plugin writes the lines, so `/`, `5j`, marks and macros work), each item
  a component painted over every window showing the buffer, as tall as it
  draws — not bound to cells. The cursor line is the focused item, ringed
  in the cursor's colour (`Cursor`) while the window is current; the list
  scrolls its own way, in pixels, only as far as it takes to keep the
  focused item in sight (`revealScroll`). A click moves the cursor there
  (and into the window) and runs the node's `on_click`, else the view's;
  the wheel scrolls the list and moves the cursor to the nearest item in
  sight when its item leaves (`wheelFocus`). An edit to the buffer
  (`on_lines`) or `view:update()` draws it again; `keys` is a hint line at
  the bottom. A view covers its window's grid, cursor included.
- **`gui.inline`** — a card under a line, in the rows an extmark's
  `virt_lines` reserve (the image plumbing, again on every scroll, fold,
  edit and window change). The page measures the card at the width it is
  drawn and sends back the rows it takes (`_inline_rows`); Lua reserves
  exactly that. The height depends on the width only and each change is
  asked about once, so it settles at once; a card out of sight is measured
  ahead (at its window's width), so scrolling to it does not jump. A card
  just above the top is drawn clipped (`topfill`), one below the bottom
  cut by the window. The cursor on its `range` marks it active (a ring);
  its keys are the plugin's buffer-local maps on those lines.
- **`gui.decorate`** — a line range (an extmark, so it follows edits)
  dimmed, highlighted (a tint and a bar in a group's colour) or tagged (a
  pill at its right), painted over every window showing it, diff windows
  included.
- **`gui.popup`** — a hover: a component at a buffer position (the cursor,
  or `{ buf, lnum, col }`; an extmark) with no Neovim window. DevHub lays it
  out its own way — prose reflowed in DevHub's type, code in the grid's face
  wrapped and coloured — as wide and tall as its content up to `max_width`
  (80 cells by default) / `max_height` and the room it has; under the
  anchor's cell, or above it when there is no room below and more above
  (`placement` says which side first; `popup.ts`'s `placePopup`), kept on
  the editor, following the anchor on every scroll and window change.
  Taller content scrolls inside, with a fade at the clipped edge; the wheel
  scrolls it, links open in the browser, a click gives the keyboard back to
  Neovim. Neovim keeps the keys: `close_on` events (default the cursor
  moving, `InsertCharPre`, `BufLeave`) close it; `:focus()` maps, on the
  anchor's buffer for as long as it is focused, `j`/`k`, `<C-e>`/`<C-y>`,
  `<C-d>`/`<C-u>`, `<C-f>`/`<C-b>`, `gg`/`G` (scrolls Lua asks of the page:
  `popup_scroll`), `q`/`<Esc>` (close), `y` (yank its `text`) and the
  popup's own `keys`, and puts back what they replaced when it closes.

  **LSP floats are popups.** devhub.nvim hooks
  `vim.lsp.util.open_floating_preview`: in DevHub's GUI, hover, signature
  help and `vim.diagnostic.open_float` are popups — markdown as `ui.md`,
  another syntax as a fenced block, plain text (a diagnostic float) as lines
  in the highlights its caller puts on the float's buffer. The hook answers
  what Neovim's does, a buffer with the lines and a window — a hidden one
  (`hide`, 0.10+), which its caller may close (the popup closes with it)
  and which closes with the popup. `K K` focuses the popup instead of
  opening a second. A float's `border` and `title` give way to DevHub's
  frame; `max_width`/`max_height` are kept. On 0.9, outside DevHub or on
  any error, Neovim's own float; `vim.g.devhub_rich_floats = false` keeps
  Neovim's always.

In plain Neovim (or a terminal), devhub.nvim's calls do nothing: a view is
its buffer's text, a card reserves nothing.

**review-relay.** devhub.nvim's `:ReviewRelay` is the first adapter: the
review panel is a view, each thread a card under its lines (markdown
comments, you / agent, Reply and Resolve, `r` and `s` on the thread's
lines), reading and writing through review-relay's CLI and endpoints and
following its event stream. See devhub.nvim's README.

### Integrations

- `devhub <file>`, `devhub -g file:line:col`, `devhub --wait`, a
  conversation's file link and Send to Agent's reference open in the
  Workspace's Neovim (`:drop`, the cursor placed, folds opened) and show its
  editor area. `AppController.openInEditor` is the one place that branches on
  the editor kind (`editor/neovimOpen.ts`).
- The window title names the file the selected Workspace's Neovim is in.
- Closing a Workspace kills its Neovim. Quitting DevHub does not: it is
  adopted next time.

## What works

Verified against Neovim 0.9.5, 0.11.5 and 0.12.6 (`neovimUi.real.test.ts`, and a
DevHub run under Xvfb; on 0.11.5 with a real lazy.nvim config: devhub.nvim's
theme, blink.cmp in insert and `:` mode, the snacks picker, fidget): typing,
the cursor and its shapes, scrolling, splits and floats, resize, the completion menu, the command line, tab pages, the clipboard
provider, GUI windows and `:DevhubTerminal`, file opens, reattaching after a
DevHub restart. SSH, against an sshd on localhost (a Workspace on
`ssh:<host>`, Neovim 0.11.5 and the same config on the host): the socket
forward, the attach, and — after the ControlMaster is killed — the page
reconnecting by itself to the same Neovim, its unsaved edit still there. Not exercised in CI.

## Limitations

- Dev containers: refused with a sentence.
- No delivery of `nvim` to hosts; Neovim 0.9 or later is expected.
- `ext_messages` off (see The attach); messages are Neovim's own, in its
  message grid.
- A GUI window's web page still gives `<C-w>` to Neovim (it has no shell
  to want it); only the terminal follows the `:terminal` model.
- An image, an inline card and a decoration do not take part in the 90 ms
  scroll slide: they jump to their new place when Neovim reports it.
- A view is laid out by the browser and scrolled in pixels; Neovim's own
  `topline` in that window is not what is shown (only the cursor line
  is). Items are all drawn (no virtualisation; a view keeps its first 5000
  lines).
- An inline card's height is whole rows: up to a row of its slot is blank
  under it.
- Notifications sit above the lowest window's status line, over whatever
  is there (a panel's hint line included).
- A popup does not carry the highlights its caller adds to a markdown
  float's buffer (signature help's active parameter is not marked); a plain
  text float's (a diagnostic's) are carried.
- `ext_hlstate` off; no semantic styling of diagnostics yet.
- A GUI buffer shown in two windows has its content (one page, one terminal
  client) in one of them — the current window when it is one, else the
  first — and the other says where it is; a click there moves the cursor in.
- The keeper window is still a window of the `ws-` session: its entry in
  the status line is made empty (`window-status-format` for that window
  only), but `next-window` or `choose-tree` in a terminal on the session
  still reach it. A keeper started before this change keeps its entry.

## Phase 2

**GUI plugin bridge for devhub.nvim.** Done: `require('devhub').gui`
(devhub.nvim) forwards `open`, `send`, `on_message`, `close`, `notify`,
`image`, `view`, `inline`, `decorate` and `popup` to the `devhub_gui`
DevHub injects — one implementation, owned by the end that speaks the RPC —
queues calls made before the attach until `User DevhubGui`, and does nothing
outside DevHub (`notify` falls back to `vim.notify`). Still to come:
diagnostics and virtual text drawn from extmarks (`ext_hlstate` +
`win_extmark`), a component for a diff hunk, and more adapters
(incremental diff review, pahcer) on the same layers.

**Terminal overlay.** `:DevhubTerminal` grows into the integrated terminal of
VS Code: several terminals (`:DevhubTerminal new`, numbered buffers), each a
DevHub pane terminal session of the Workspace (on the Workspace's machine
even when Neovim runs in a container), `<C-w>` navigation, a `terminal`
layout preset, and the Sidebar's terminal activity marks.

**Also:** dev containers (Neovim in the container through `docker exec`, its
socket reached by a relay like the `devhub` command's), delivering `nvim` to
hosts like tmux and bash are, `ext_messages` on 0.10+, ligatures, a
glyph-atlas (WebGL) painter if large redraws need it, and the
Sidebar following the current buffer.
