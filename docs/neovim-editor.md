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
  Retry button), forwarding again and adopting the same Neovim. A closed connection only counts as Neovim
  ending when its keeper pane is gone or dead: before, the drop unlinked the
  host's socket, so Retry started a second Neovim beside the orphaned first.
- **A dev container**: not yet. A Workspace whose editor is attached to a
  container says so ("does not run in a dev container yet").
- **No `nvim`**: the page says which machine lacks it and what to do
  (`brew install neovim`, or install it on the host). DevHub does not deliver
  Neovim to hosts (yet).

### The attach

`main/editor/neovimUi.ts` attaches with `rgb`, `ext_linegrid`,
`ext_multigrid`, `ext_popupmenu`, `ext_cmdline` and `ext_tabline`.
`ext_messages` stays off: in 0.9 it is experimental and takes the message area
away, so messages are drawn by Neovim in its message grid. Before attaching it
runs a Lua snippet (`SETUP_LUA`) that:

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
  page hands to `nvim_paste` (one undoable change, in any mode). The chords
  still come first;
- defines the `devhub_gui` Lua module and `:DevhubTerminal`, `:DevhubGuiDemo`.

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
  the special colour, `reverse`, float `blend`. Floats get a shadow and
  rounded corners. Ligatures off. The font is `guifont` if set, else DevHub's
  terminal font (Settings > Terminal); `linespace` is honoured.
  - The cell is measured on whole device pixels (crisp at
    `devicePixelRatio` 2; the text of a run is spread to the cell with
    `letterSpacing`), and measured again when the window moves to a screen of
    another density.
  - Box-drawing characters (`│ ─ ╭ ╮ ╰ ╯ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ┃ ━ ▏ ▕`) are drawn
    as lines through the whole cell, so window separators and float borders
    stay unbroken with any `linespace`.
  - A full repaint of a 164×43 screen with two windows and a float takes
    about 6 ms; there is no glyph atlas, and none has been needed.
- The cursor follows `guicursor`: its shape, its highlight, and its blink
  (`blinkwait`/`blinkon`/`blinkoff`, restarted on every move). It glides to a
  new cell in 70 ms outside Insert mode (none with reduced motion).
- Each window gets an overlay scrollbar from `win_viewport`, shown while the
  view moves and faded out after.
- `keys.ts` — a `keydown` as key notation: `<C-…>`, `<M-…>` for Option when
  `[terminal] mac_option_is_meta` says it is Meta (left/right tracked as in
  DevHub's terminals), `<D-…>` for Cmd, named keys, `<lt>` and friends.
  Printable keys arrive as text (`ime.ts`). `Cmd+Q` and the chords never get
  here: main's key router takes them first, as for every surface.
- `ime.ts` — the hidden textarea's events as a state machine: the preedit is
  drawn inline at the cursor, underlined, and only the committed text is sent
  (once); the textarea sits on the cursor so the candidate window opens there.
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

A GUI window is a scratch buffer (`buftype=nofile`, `filetype=devhub_gui`,
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

**`:DevhubTerminal`** (`:DevhubTerminal float`) is the same idea: a Neovim
window (a split at the bottom by default) that DevHub fills with the
Workspace's DevHub terminal — its tmux session, on the Workspace's machine. It
is a Neovim window for layout and navigation, and a terminal for input; the
same command toggles it. It wears Neovim's default colours rather than the
terminal theme's, so it reads as part of the editor, and it leaves out the
session's tmux status line — Neovim's statusline is right under it. The
keeper window is started with `$DEVHUB_TMUX` (the tmux that runs the server),
through which `devhub_gui` reads `status` and `status-position`; the terminal
is fitted that many rows taller and those rows are clipped
(`TerminalSurface`'s `hiddenRows`), so the shell keeps every row it shows.

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

Verified against Neovim 0.9.5 and 0.11.5 (`neovimUi.real.test.ts`, and a
DevHub run under Xvfb; on 0.11.5 with a real lazy.nvim config: devhub.nvim's
theme, blink.cmp in insert and `:` mode, the snacks picker, fidget): typing,
the cursor and its shapes, scrolling, splits and floats, resize, the completion menu, the command line, tab pages, the clipboard
provider, GUI windows and `:DevhubTerminal`, file opens, reattaching after a
DevHub restart. SSH, against an sshd on localhost (a Workspace on
`ssh:<host>`, Neovim 0.11.5 and the same config on the host): the socket
forward, the attach, and — after the ControlMaster is killed — the page
reconnecting by itself to the same Neovim, its unsaved edit still there. Not exercised in CI.

## Limitations (phase 1)

- Dev containers: refused with a sentence.
- No delivery of `nvim` to hosts; Neovim 0.9 or later is expected.
- `ext_messages` off; messages are Neovim's own, in its message grid.
- `ext_hlstate` off; no semantic styling of diagnostics yet.
- A GUI buffer shown in two windows has its content (one page, one terminal
  client) in one of them — the current window when it is one, else the
  first — and the other says where it is; a click there moves the cursor in.
- The keeper window is still a window of the `ws-` session: its entry in
  the status line is made empty (`window-status-format` for that window
  only), but `next-window` or `choose-tree` in a terminal on the session
  still reach it. A keeper started before this change keeps its entry.

## Phase 2

**GUI plugin bridge for devhub.nvim.** `devhub_gui` becomes the API plugins
use, shipped in devhub.nvim (`require('devhub').gui`), with the same rule —
every surface is a Neovim object:

```lua
local gui = require('devhub').gui
local panel = gui.panel{
  title = 'Tests', html = …, -- or component = 'markdown' | 'image' | 'diff'
  win = { split = 'right', size = 50 },  -- or float = { relative = 'cursor', … }
  keys = { ['<CR>'] = function(ctx) … end },  -- keys while the panel has focus
  on_message = function(msg) … end,
}
panel:send(value); panel:close()
gui.decorate(buf, extmark_id, { image = path, height = 8 })  -- an image in
                            -- virt_lines space, anchored to an extmark
gui.notify{ title, body, level }   -- a native toast (ext_messages-free)
```

Panels get DevHub's theme tokens as CSS variables and a typed `devhub` object
(`send`, `onMessage`, `nvim.request(method, …)` for a whitelisted subset).
Native rendering where it adds value: diagnostics and virtual text drawn from
extmarks (`ext_hlstate` + `win_extmark`), inline images in `virt_lines` space,
LSP hover and signature help in DevHub floats.

**Terminal overlay.** `:DevhubTerminal` grows into the integrated terminal of
VS Code: several terminals (`:DevhubTerminal new`, numbered buffers), each a
DevHub pane terminal session of the Workspace (on the Workspace's machine
even when Neovim runs in a container), `<C-w>` navigation, a `terminal`
layout preset, and the Sidebar's terminal activity marks.

**Also:** dev containers (Neovim in the container through `docker exec`, its
socket reached by a relay like the `devhub` command's), delivering `nvim` to
hosts like tmux and bash are, `ext_messages` on 0.10+, ligatures, smooth
scrolling, a glyph-atlas (WebGL) painter if large redraws need it, and the
Sidebar following the current buffer.
