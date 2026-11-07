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
  Retry forwards again and adopts the Neovim that went on running.
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
- maps `<D-v>`, `<D-c>`, `<D-s>` unless the person mapped them;
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
- `painter.ts` — a 2D canvas per grid, repainted a dirty row at a time on the
  animation frame after a `flush`; runs of one highlight, wide characters cell
  by cell, underline/undercurl/underdouble/dotted/dashed/strikethrough in the
  special colour, `reverse`, float `blend`. Floats get a shadow and rounded
  corners. Ligatures off. The font is `guifont` if set, else DevHub's terminal
  font (Settings > Terminal); `linespace` is honoured.
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
same command toggles it.

### Integrations

- `devhub <file>`, `devhub -g file:line:col`, `devhub --wait`, a
  conversation's file link and Send to Agent's reference open in the
  Workspace's Neovim (`:drop`, the cursor placed, folds opened) and show its
  editor area. `AppController.openInEditor` is the one place that branches on
  the editor kind (`editor/neovimOpen.ts`).
- Closing a Workspace kills its Neovim. Quitting DevHub does not: it is
  adopted next time.

## What works

Verified against Neovim 0.9.5 (`neovimUi.real.test.ts`, and a DevHub run under
Xvfb): typing, the cursor and its shapes, scrolling, splits and floats,
resize, the completion menu, the command line, tab pages, the clipboard
provider, GUI windows and `:DevhubTerminal`, file opens, reattaching after a
DevHub restart. SSH: the forward is built and unit-tested; not yet exercised
against a real host in CI.

## Limitations (phase 1)

- Dev containers: refused with a sentence.
- No delivery of `nvim` to hosts; Neovim 0.9 or later is expected.
- `ext_messages` off; messages are Neovim's own, in its message grid.
- `ext_hlstate` off; no semantic styling of diagnostics yet.
- The 2D canvas painter has no glyph atlas; it is fast enough for typing and
  scrolling, not measured for huge redraws.
- A GUI window shown in two windows draws its content in the first only.
- The window title does not follow the current file yet.
- Cmd+C/Cmd+X in visual mode depend on the `<D-c>` mapping; with the app
  menu taking Cmd+C first, `"+y` is the reliable way.
- The keeper window shows in the `ws-` session's window list
  (`1:devhub-nvim`) of a terminal attached to it.

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
window title and Sidebar following the current buffer.
