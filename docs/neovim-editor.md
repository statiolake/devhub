# The Neovim editor: DevHub as a GUI for Neovim

With `[general] editor = "neovim"` a Workspace's editor area is not a VS Code
workbench but **its terminal**: the Workspace's `ws-` tmux session, which is
what DevHub shows when it starts and when a Workspace is opened or selected.
Neovim is something opened inside it, and every Neovim there is DevHub's own
GUI for it, drawn through Neovim's UI protocol exactly over its tmux pane:

- `nvim` typed in a pane — of the Workspace's terminal or an Agent's — or run
  by `git commit`, `crontab -e`, `$EDITOR` (see Neovim in a terminal);
- the Workspace's one `devhub-nvim` window, where `devhub <file>`, a
  conversation's file link and Send to Agent's reference open (see
  Integrations).

Neovim owns the buffers, the windows and their layout, the modes, the
plugins and the language servers; DevHub draws, and adds GUI-native widgets
that are attached to Neovim objects and follow them.

```toml
[general]
editor = "neovim"   # "vscode" (the default): each Workspace's own VS Code
```

Settings > General > Editors > Editor is the same switch. It applies at once:
with "neovim" no workbench is started for any Workspace (the lifecycle plan
wants none, `planWorkbenches`), and one that was running is closed; back to
"vscode", the terminals are taken out of the editor area and the workbenches
start as before (on Enter, or a file opened into them). The VS Code path is
untouched. There is no separate switch for Neovim over terminals: it is what
`editor = "neovim"` is (`neovim_terminal_overlay` is gone, and refused).

There is no editor surface apart from the terminal, no "Editor not running"
placeholder and nothing to start: the terminal attaches as the area is shown,
and a session that ended (its last window closed) is made and attached again
at once. `Cmd+Q Shift+E` stops nothing here and says so; `:q` ends a Neovim.

## Architecture

```
 neovim.html#tnv:<n> (one per pane)      Neovim host (utility process)     the Workspace's machine
 ┌───────────────────────────────┐ port ┌──────────────────────────┐      ┌──────────────────────────┐
 │ redraw.ts  (pure reducer)     │◀─────│ NeovimUiSessions         │◀─────│ nvim --headless --listen │
 │ painter.ts (a canvas per grid)│redraw│  NeovimUi (attach,       │ rpc  │   in its devhub-nvim     │
 │ widgets: pum, cmdline, tabs,  │─────▶│  GUI windows), msgpack   │─────▶│   tmux window (or a      │
 │  GUI windows (iframe)         │calls └──────────────────────────┘      │   pane's nvim); socket:  │
 │ keys.ts ime.ts mouse.ts       │        ▲ attach, ended, clipboard      │   local, or ssh forward  │
 └───────────────────────────────┘        │                    ┌──────────┴───────────────┐
          │ attach (invoke)        ┌──────┴──────────────┐      │ (a second connection:    │
          └───────────────────────▶│ main: NeovimEditors │─────▶│  lifecycle, file jumps,  │
                                   │  ManagedNeovims     │ rpc  │  theme)                  │
                                   └─────────────────────┘      └──────────────────────────┘
```

The UI's connection is its own: main's `ManagedNeovims` keeps one
connection per server for its lifecycle (it closing is Neovim having
exited), the file jumps and the theme; the UI opens a second one to the
same socket (on an SSH host, the same forward) and runs in the Neovim host
(`main/neovimHost/`), which sends every redraw to the page over the page's
`MessagePort` and takes its calls back on it. Main answers the attach (which
Neovim, which socket), hands the port out, and answers the clipboard, which a
utility process has none of. A host that ends is restarted and the pages
reconnect by themselves; after three ends in a minute, or with
`DEVHUB_NEOVIM_IN_MAIN=1`, the same code (`editor/neovimUiSessions.ts`) runs
in main and the page's calls and redraws are IPC (`docs/process-model.md`,
phase 5c).

### The process

Two kinds of Neovim, drawn the same way:

- **The Workspace's `devhub-nvim` window.** `main/editor/managedNeovim.ts`
  keeps one Neovim per Workspace for the files DevHub opens:
  `env DEVHUB_NEOVIM_GUI=1 nvim --headless --listen <socket>` with the
  person's own config, cwd the Workspace's folder, in a window named
  `devhub-nvim` of the Workspace's `ws-` session, made the first time a file
  is opened. Each open selects that window and names the socket on its pane
  (`@devhub-nvim`), and the terminal draws the GUI over the pane; the pane
  itself draws nothing (the Neovim is headless). tmux keeps it across a
  DevHub restart and an SSH connection dropping, and the next DevHub adopts
  it by its socket, a digest of the Workspace id.
- **A `nvim` run in a pane**, by DevHub's shim (Neovim in a terminal): the
  person's own Neovim as that pane's foreground program.

Neither is ever used for the other's job: an open never goes to a Neovim the
person started (a `git commit` waiting on its editor gets no other file),
and `nvim` in a pane never reuses the `devhub-nvim` one.

Each is drawn by a `neovim.html#tnv:<n>` page over its pane
(`main/editor/terminalNeovims.ts`), with its own UI connection to the socket
(below).

- **This Mac**: the socket is in DevHub's own `0700` directory and is
  connected to directly.
- **An SSH host**: the socket is in `${TMPDIR:-/tmp}/devhub-nvim-<uid>/` on the
  host, and is forwarded to a socket here over the host's ControlMaster —
  `ssh -O forward -L <here>:<there>` (`Runtime.forwardUnixSocket`,
  `editor/neovimMachines.ts`). A dropped connection takes the forward with it
  and the overlay goes, while the Neovim runs on in the host's tmux; the
  next file opened into the Workspace forwards again, adopts that same
  Neovim (its unsaved edits still there) and draws it again. A closed
  connection only counts as Neovim ending when its pane is gone or dead, so
  a drop never unlinks the socket of a Neovim still running there.
- **A dev container**: not yet. A Workspace whose editor is attached to a
  container says so ("does not run in a dev container yet").
- **No `nvim`**: the open is refused with a notice naming the machine that
  lacks it and what to do (`brew install neovim`, or install it on the
  host). DevHub does not deliver Neovim to hosts (yet).

### The attach

`main/editor/neovimUi.ts` attaches with `rgb`, `ext_linegrid`,
`ext_multigrid`, `ext_hlstate`, `ext_popupmenu`, `ext_cmdline` and
`ext_tabline`. `ext_hlstate` only adds the groups each highlight is made of
(`hl_attr_define`'s info: `ui_name`, `hi_name`); the page keeps them on the
highlight and knows a diff's filler and the
end-of-buffer `~` by name, not by colour.
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
  page hands to `nvim_paste` (one undoable change, in any mode). A GUI
  window's page answers Cmd+C/X/A/Z on its own selection. With nothing selected,
  Cmd+C and Cmd+X take the line (in Normal and Insert mode): an unmapped
  `<D-x>` would reach Neovim as a plain `x`. The Edit menu clicked with the
  mouse does the same: its Copy, Cut, Undo and Redo arrive at the page's
  hidden textarea as `copy`/`cut` events and `historyUndo`/`historyRedo`
  input, which the page sends as `<D-c>`, `<D-x>`, `<D-z>`, `<D-Z>` (Select
  All from the menu does nothing yet). The chords still come first;
- defines the `devhub_gui` Lua module, `:DevhubGuiDemo` and
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
  against their anchor grid, the message grid on top, cut at the screen's
  last row as Neovim's compositor cuts it (the grid is as tall as the
  screen and keeps a `:messages`' old rows below the `cmdheight` rows).
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
  the left-out border falls through (`GridBox.crop`); a blank border
  with a title or footer keeps that row, a header inside the frame. One
  whose border is lines (`'rounded'`, `'single'`, `'double'`, heavy,
  dashed, a table of box-drawing characters) is cut at its line
  (`frame.ts`, `GridBox.frame`): the line is the float's edge, nothing of
  the border cells outside it is drawn — the windows behind show there,
  and a click there goes to them; inside it, the border's ground. The
  canvas is the text area; the lines are DevHub's (CSS borders on whole
  device pixels, where `glyphShapes` would have drawn `─ │ ╭`, a rounded
  corner's arc as the radius), with the shadow following that outline.
  Framed floats edge to edge meet half way between their lines and the
  edge they share is drawn once (`framePieces`); only the panel's outer
  corners stay round. A borderless float wholly behind framed ones (a
  picker's root box) is not drawn (`underFrames`). The `title` and
  `footer` are labels on the line, in their highlights, where Neovim put
  them (`title_pos`/`footer_pos`), the line broken around them: the page
  asks `nvim_win_get_config` when a border holds text, and until the
  config explains that text (or when it does not) the float is drawn cell
  for cell, as Neovim drew it. Any other border (ASCII, block elements, a
  side with text) is drawn as Neovim says, with only a shadow: never two
  frames (`floatBorder`). With `winblend`, the ring between the lines and
  the text is blended and the panel has no shadow. Ligatures off. The font is `guifont` if set, else DevHub's
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
  - Selections and search matches are their highlight's own fill, square
    and continuous: the whole cell, `linespace` included, with no seam
    between cells or rows (a terminal's grid shows one).
  - A window separator's cell is drawn as the two sides meeting
    (`separatorsOf`): each half in the ground beside it, its line between.
  - The `~` past the end of a buffer (in `EndOfBuffer`) is not drawn while
    the window's `fillchars` has no `eob:` of the person's
    (`isEndOfBuffer`); a `:setlocal fillchars` is seen at once
    (`OptionSet`, and on `FileType`/`BufWinEnter` when a window's differs).
  - A diff's filler rows (the default `diff:` `-`) are hatched: thin
    diagonals in the foreground, continuous from row to row.
  - A menu's scrollbar made of one-column floats (blink.cmp, nvim-cmp) on
    a menu's right edge is an overlay scrollbar: the gutter not drawn, the
    thumb a thin bar.
  - Status lines, winbars, the fold column, indent guides and
    `MatchParen` are what Neovim and the person's config say, cell for
    cell; only the glyphs a terminal approximates are drawn as what they
    mean (box drawing, blocks and Powerline separators as geometry,
    continuous across `linespace`).
  - Decorations in a proportional face (`decor.ts`,
    `main/editor/neovimDecor.ts`): virtual text at the end of a line
    (diagnostics, git blame), right-aligned and inline (inlay hints),
    virtual lines, and a closed fold's text are not the buffer's content,
    so their words are set in the UI face a step under the editor's size,
    as the completion menu's labels are: words about the code, not code.
    Does Neovim drawing them on cells make them drift? No, as long as they
    stay inside their cells. Neovim lays them out in cells, and everything
    after them — the buffer text after an inlay hint, the cursor, a
    click's cell, a selection — is placed by those cells, not by what the
    GUI draws in them. A proportional word is usually narrower than its
    cells, so it is drawn inside them and the slack is left blank; one
    wider (rare) is set narrower to fit, never past them. What cells cannot
    say is _which_ cells are virtual: `grid_line` does not tell. So Lua
    says: after every redraw that drew a window, the extmarks in its
    visible lines (`nvim_buf_get_extmarks` with details) and its closed
    folds (`foldclosed`, `foldtextresult`) are placed with `screenpos` and
    sent as rows and columns of the window's grid with their text (only
    when they changed). The page sets one only where the grid holds exactly
    that text there now — a few cells off is looked for, nearest first,
    since a character typed before a hint moves it before Lua speaks
    again — and anything else is cells as before: a guess is never drawn.
    - The words only: padding blanks at either end and drawing characters
      (a virtual line's `└────` under the column it points at) stay on
      cells; the ground is the cells' (the highlight's box, as Neovim says).
    - The slack: inline hints keep to the code they name — one ending in
      `:` (a parameter's name) to the code after it, the slack before;
      any other (`: i32`, `-> T`) to the code before, the slack after,
      where reading goes on. Right-aligned text keeps to the window's
      edge. The rest starts where Neovim starts it.
    - A fold's `+--` marker stays on cells: the cursor sits on its first
      cell on a closed fold, and its dashes count the level. The words
      after it are set; the fill after them is the fold's.
    - Left as cells: `overlay` and `virt_text_win_col` text (put on the
      buffer's own columns — indent guides, tables, concealed markup —
      it only works on cells), `virt_lines_above`, and a fold whose
      `foldtext` is empty (the line itself, content).
    - Wide characters take their two cells in the match; a CJK word in a
      proportional face is about as wide as its cells.
  - A closed fold's fill, when the person's `fold:` character draws a line
    (`─`, `-`, heavy, double or dashed), is one hairline fading out over
    about a dozen cells (260 px; mock C1 of round 6): it leads from the
    fold's words into the lines it stands for without ruling a line across
    the editor that reads as a separator. Box drawing's own line (its
    thickness and place), in the fill's colour. Any other fill —
    Neovim's default `·`, the person's — is drawn as Neovim says.
  - The underline family and strikethrough (`strokes.ts`) are drawn as type
    is: as thick as the face asks, on whole device pixels under the
    baseline; undercurl a true wave whose phase is the row's (runs side by
    side make one wave), dots round, dashes even, strikethrough through
    the lowercase letters.
  - A full repaint of a 164×43 screen with two windows and a float takes
    about 6 ms (15 000 cells at `devicePixelRatio` 2: about 4 ms); there is
    no glyph atlas, and none has been needed.
- The cursor follows `guicursor`: its shape, its highlight, and its blink
  (`blinkwait`/`blinkon`/`blinkoff`, restarted on every move; each edge
  fades over 120 ms of its phase). Square, as the cell. The character
  under a block is painted as its row paints it (`paintCursorCell`: the
  cell's face, the grid's baseline, box drawing and icons as shapes) in
  the cursor's colours, on exactly the device pixels it has off the cursor
  — as page text it sat half a pixel or a pixel off the row's baseline,
  depending on font and size (the line box rounds ascent and descent its
  own way), and lost bold, italic and wide cells. It glides to a
  new cell in 70 ms outside Insert mode (none with reduced motion), but
  never across a scroll of its window: then it moves with the text at
  once.
- A window scrolls in pixels (`smoothScroll.ts`; 0.10+, which says how far
  a window scrolled in `win_viewport`'s `scroll_delta`): the trackpad and
  the wheel move its text pixel for pixel while Neovim's `topline` stays a
  whole line of Neovim's. Each time Neovim scrolls a window, what was on
  screen becomes a _ghost_ (an image of the text area); the canvas and the
  ghost are moved by transforms inside a clipping element of the text area
  (`.nvim-scroll-port`, the compositor's work, nothing repainted), and
  between them cover every position the display can be at. The wheel keeps
  Neovim ahead of the display by a line, or by twice as far as the wheel
  goes while Neovim answers and a frame draws it (the round trip is
  measured; a flick's first event counts as a frame's worth), less than a
  window at a time: in Normal mode by that many screen rows (`<C-e>`/`<C-y>`
  with `normal!`, one at a time until the view moved that far, counted with
  `nvim_win_text_height`: a wrapped line moves by all its rows at once
  unless `smoothscroll`, filler and virtual lines by a row each; a line
  taller than the window by a row at a time, `smoothscroll` set on the
  window while its view is inside that line (skipcol) and the person's
  value back as soon as it is not, before its buffer leaves the window,
  and in a window split from it — Neovim keeps no skipcol without it; in the
  window under the pointer, current window unchanged, unless the person
  mapped the wheel); in any other mode Neovim's own wheel. One request is
  in flight at a time and is not given up before Neovim answers (a busy
  Neovim, a file just opened, would otherwise get one after another and
  scroll by all of them); once answered, until its redraw comes. Windows
  `scrollbind` moves with the wheeled one (a diff) show the same offset
  from Neovim's view, frame for frame (they scroll by the same rows, the
  filler keeping them in line): no drift, no easing behind. The
  cursor ends where Neovim's own wheel would leave it: Neovim's lead pushes
  it further than the display went, so `SCROLL_LUA` keeps the cursor the
  wheel alone would leave — pushed only by the furthest the display went
  each way in the gesture (`reach`), `scrolloff` kept, and staying pushed
  when the gesture turns back — and puts it back when Neovim is brought to
  rest. At rest
  Neovim is brought back to the nearest line boundary (a wrapped line's
  start, not a row inside it; inside a line taller than the window, the
  nearest row) and the display eases onto
  it, so what is shown is Neovim's grid again, exactly. A scroll Neovim
  makes itself (`<C-d>`, `<C-f>`, `zz`, `j` past the edge, a search) eases
  from the old view to the new in 90 ms, already under way on the first
  frame drawn (keys are never held); a jump of a window or more (`G`) is
  not eased. The cursor rides with its text (a transform) and does not
  glide while its window scrolls — Neovim's scroll moves its row at once
  and the display's offset takes the rows back, so a glide to the new row
  put it rows off its cell for 70 ms, the trackpad's warping cursor; a
  winbar stays
  put, a click lands on the line under the pointer. Not for floats or the
  message grid, not on 0.9, and with reduced motion only the wheel's own
  movement.
- Lines a `dd`, `p` or `o` moves slide into place in 60 ms (the
  person's pick of three mocks, round 6: 0, 60, 100 ms): what was
  deleted closes up, what was put in opens a gap, so the eye sees where
  the lines went. It is told from Neovim's own redraw: a `grid_scroll` in
  a window whose `win_viewport` says it did not scroll (0.10+), at most a
  third of the window, one per frame. An image of the region as painted
  moves inside a clip of it (`slideLines`); the canvas under it is already
  final, so no key waits for it, rows repainted meanwhile (the cursor
  line, a blame text) go on sliding as they are, and another move or a
  whole repaint ends it at once. Not while a window is pixel-scrolled,
  not in floats, not with reduced motion; 60 ms is over before the next
  key at any typing speed.
- What sits on a window's text rides it (`riders.ts`): inline images and
  cards, decorations and popups (the page's DOM) are drawn where their line
  is shown, moved by a transform each frame and cut to the window's text
  area. Lua places them in rows from the window's top, beyond the window
  too (up to a window's height, counted with `nvim_win_text_height`: the
  display shows that much past Neovim's view while Neovim leads), after
  the redraw of the state it counted in (`M._drawn`); the page counts a
  placement from the rows the window had scrolled when it came and moves
  it by the rows painted since, so a placement a redraw behind or ahead of
  the canvas still lands on its line. A Neovim float at a buffer position
  (`relative='win'` with `bufpos`, asked once per float with
  `nvim_win_get_config`) moves with its anchor window's display, frame and
  shadow too; a float at a fixed cell (`relative='cursor'` is one) stays,
  as Neovim keeps it. Neovim pins a float whose line has left its view to
  the window's top edge; while the display still shows that line (Neovim
  led past it), the float is where it was when its line was last in
  Neovim's view, moved by the rows scrolled since (`pinnedRows`); once the
  line is off the display too, it is where Neovim pins it.
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
  first; a framed float only inside its lines, which toward a float edge to
  edge with it go on to its cells' edge), drags kept on the press's grid
  (a press on grid 1 — a window border, a status line — drags in grid 1's
  cells over the windows too, so Neovim resizes: before, such a drag
  stopped at the first window it crossed), a window's vertical wheel in
  pixels (above); sideways, with a modifier or over anything else, pixels
  accumulated into line steps. A border a drag resizes (`sashAt`: the
  column between windows side by side, the row between a window and the
  one under it) gives the pointer `col-resize`/`row-resize`, nothing more.
  Keys: `<C-w><`, `<C-w>>`, `<C-w>+`, `<C-w>-`, `<C-w>=`.
- Resize: the view's size over the cell size, `nvim_ui_try_resize`.
- Focus: `nvim_ui_set_focus` (FocusGained/FocusLost), told once per
  change. The editor has the keyboard when its textarea is focused _and_
  its view has the keys (`document.hasFocus()`, followed on the window's
  `focus`/`blur`): a page keeps its focused element while the Sidebar, an
  Agent or a terminal view has them. Without it the block cursor is
  hollow, a bar or underline (and the command line's caret) faint and
  steady.
- Widgets in DevHub's chrome: the completion menu at its anchor cell (flipped
  above near the bottom, scrolls to the selected item, click to select;
  drawn as below, "The completion menu"), the command line (firstc, cursor, special
  char, `cmdline_block` for multiline; where it is, below), and tab pages as a native tab strip
  (click switches via `nvim_set_current_tabpage`; `gt`/`gT` are Neovim's):
  the current tab wears the editor's ground and joins it, over the strip's
  bottom line, as an editor's tab does. Tabs keep their names at their
  width (`TabStrip.tsx`, VS Code's `tabSizing: fit`; before, many tabs
  squeezed to `p…`) and the strip scrolls sideways: the current tab is
  brought into view whenever it changes, so `gt` reaches one out of view;
  the wheel scrolls the strip; an edge with more beyond fades out; the
  full name is the tooltip.
- The command line's text is laid out on cells as Neovim's own command line
  holds it (`cmdline.ts`): `cmdline_pos` is a byte offset, a wide character
  takes two cells, a combining mark joins the one before, the text wraps at
  the bar's width, and `cmdline_special_char` shows at the cursor (put in
  with `shift`, else over the character there). The caret sits on that cell
  in the current mode's `guicursor` shape, colours and blink (`c`, `ci`,
  `cr`), in `cmdline_block` and after an `input()` prompt too; an IME's
  preedit and candidate window go there while the bar is up.
- Where the command line is (`cmdlinePlace`). With `cmdheight` > 0 —
  the person's config has rows kept for it — it is in those rows at the
  bottom, from the first column, its text on the first of them, as Neovim
  draws its own: the editor's own line, in the editor's ground and text,
  with no frame, shadow or arrival. The rows the person gave the command
  line are where they read what they type; a palette elsewhere would leave
  them empty and move the eye. What makes it a GUI's stays: the caret in
  `guicursor`'s shape and blink, crisp text on cells, the completion menu
  over the word it completes (opening upward from the line), an IME's
  preedit and candidates at the caret. A wrapped line or a
  `cmdline_block` that needs more rows rises over the windows above, as
  Neovim's message area does. With `cmdheight=0` no row is kept: drawn at
  the bottom it would cover the last window's last lines and its status
  line, so there it is the palette-like bar near the top, centred, where
  it covers least of what is being edited.
- Either sits on whole cells in the grid's font, and Neovim is told where:
  `g:ui_cmdline_pos` (`[row, col]`, the convention noice.nvim started),
  which blink.cmp's `:` completion menu reads. At the bottom it names the
  text's own row, so blink's menu opens above it, as at Neovim's own
  command line; for the palette, the row under the bar's text, so the
  menu opens under it instead of at the bottom.
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

In a float with a border (`win = 'float'`), the content goes inside
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
one-way events on one RPC method (`devhub_gui_event`; the Neovim host forwards them as
`gui-event` on the page's port; `shell/neovim/decorations.ts` is the page's
reducer, `DecorationViews.tsx` draws them). A payload of the wrong shape is
ignored, so anything odd leaves Neovim's own grid showing; a page that
attaches again is told every image again.

```lua
local gui = require('devhub_gui')          -- or require('devhub').gui (devhub.nvim)
gui.notify{ title = 'Build', msg = 'done', level = 'warn' }   -- a notification
local img = gui.image(0, 5, '~/shot.png', { height_rows = 10 }) -- under line 5
img.clear()
```

- **notify** — in fidget's spirit (round 7, the person's pick of four
  mocks): quiet lines at the bottom right under the name of their source
  (`group`), by level (`info`, `warn`, `error`, `debug` or
  `vim.log.levels.*`), fading after 4–8 s (or a click). A `key` updates
  the notification it named in place, so work in progress
  (`progress = true`, `percent`, `done`) shows how far it is and ticks
  when done (gone 2 s later). devhub.nvim's `setup{ notify = true }` makes
  `vim.notify` this (its `title` is the source) and shows `LspProgress`
  (0.10+) the way fidget does. Not `ext_messages`: Neovim's messages stay
  Neovim's. Each choice and its reason (`DecorationViews.tsx`,
  `veil.ts`):
  - _Place._ The lowest line on the row over the lowest window's status
    line; the right edge a cell in from the window's, the edge the status
    line's file name keeps: out of the reading path, next to what already
    says what the editor is doing, and no new alignment line.
  - _Type._ The UI face at the editor's size and weight: monospace exists
    so code columns line up, prose has none, and a monospace line over
    code reads as more code; the editor's size adds no new size. Lines on
    the editor's line pitch, so they interleave with the code's rhythm.
  - _Tones._ The source in `Normal`, a message in `Comment` (an aside, as
    the scheme already marks asides), a title `Comment` 62 % toward the
    ground; a warning or error mixes its `Diagnostic*` colour 65 % into
    the message. Nothing brighter than the code, no level words, no marks
    for levels.
  - _Progress._ A ring in a cap-high box half an em after the text: a
    faint track (25 %) and an arc as long as the percentage — "how far"
    drawn, not printed; an arc turning once in 1.2 s without a
    percentage (no braille frames every 80 ms); a check in `DiagnosticOk`
    when done, the one change worth a colour. Stroke a tenth of an em.
  - _Grouping._ By space alone: half a line between sources; no card, no
    rule, no shadow.
  - _Width._ At most 48 cells, then an ellipsis: it stays in its corner.
  - _Backdrop._ Under the text only, in the text's shape: each line a
    capsule as long as that line (1.5 σ past its ends, ½ σ above and
    below), the capsules unioned and feathered together with σ = ¼ line,
    so a short line between two long ones keeps a short region and the
    whole reads as a soft cover with no rectangle, no hull and no edge.
    Inside it the code is blurred by 1 px (the fine detail that competes
    with the letters) and tinted 45 % toward `Normal`'s ground — over
    empty ground that changes no pixel, so there it is invisible. The
    shape follows the lines every frame while they come, move and go.
    Softening is for this alone: high in volume, transient.
  - _Motion._ A line comes in by fading (240 ms, ease-out) while the
    lines above move up by its height on the same curve; it leaves by
    fading slowly (600 ms, ease-in) and only then does its gap close
    (300 ms): nothing moves while its text shows. Reduced motion: fades
    only, a still arc.
- **image** — an extmark's `virt_lines` reserve `height_rows` blank rows
  under the line, so Neovim lays them out (the cursor steps over them,
  `:vsplit` shows them twice) and DevHub paints the image there. A path is
  read on Neovim's machine and sent as a `data:` URL (an SSH host's file
  works; 0.10+ for `vim.base64`); an `https:` URL is passed as it is. Where
  it is — the row under the line's last screen row, after the rows of any
  `virt_lines` Neovim stacks there first (another image, a card, a
  plugin's), the text column, from the window's top — is worked out again
  (`screenpos`, `getwininfo`) on
  every `WinScrolled`, `WinResized`, `CursorMoved`, `TextChanged`, window
  open/close and tab change, for every window of the tab page showing the
  buffer; a closed fold hides it, a window's bottom clips it.
  `:DevhubImageDemo [path]` opens a markdown buffer with one (with no path,
  a small generated PNG).

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
  in the highlights its caller puts on the float's buffer. A highlight its
  caller puts on a markdown float's code (signature help's
  `LspSignatureActiveParameter`) is a `marks` entry of the `ui.md` node —
  its source line and UTF-16 columns — drawn over the coloured code in
  that group's colours (a ground as a chip; a group with no ground or
  weight bold and underlined). The hook answers
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
  Workspace's `devhub-nvim` window (`:drop`, the cursor placed, folds
  opened), made when it is not there. The Workspace is selected (beside the
  asking Agent, for a link from one), tmux is switched to that window, and
  the keys go to the Neovim drawn over it, wherever they were.
  `AppController.openInEditor` is the one place that branches on the editor
  kind (`editor/neovimOpen.ts`).
- `devhub` itself goes on the PATH from DevHub's command palette, **DevHub:
  Install 'devhub' command in PATH** (`Cmd+Q :`, `install_cli`): DevHub's own
  command, since with Neovim there is no workbench palette to run it from.
- Leaving it is tmux's and Neovim's: `:q` ends that Neovim, its window
  closes and tmux shows the window it shows next, with the keys in it; the
  prefix and a window key (`l`, `0`, `n`) go back and forth with the
  Neovim kept; `<C-o>`, `:b#` and the rest move within it. The next open
  makes the window again.
- The window title names the file of the Neovim the selected Workspace's
  terminal shows (its active pane's), whichever kind it is.
- Closing a Workspace kills its `devhub-nvim` Neovim. Quitting DevHub does
  not: it is adopted next time.

## Neovim in a terminal

With `editor = "neovim"`, `nvim [args]` in a DevHub terminal — the
Workspace's (its editor area) or an Agent's; typed, or run by
`git commit`, `crontab -e`, `$EDITOR` — is the person's own Neovim drawn by
DevHub's GUI exactly over that tmux pane, in place of its TUI. The command
blocks like any editor and returns Neovim's exit status (`:cq` fails a
commit). It works the same in a terminal on an SSH host.

**The shim** (`main/editor/terminalNeovimShim.ts`). DevHub writes a POSIX
`sh` script named `nvim` on each machine — `<DevHub's data>/devhub/nvim-bin/`
here, `~/.devhub/terminal/nvim-<tag>/` on a host — and puts its directory in
front of the PATH of every pane it creates while the editor is Neovim (the
way a host's `devhub` is). PATH and not `EDITOR`/`VISUAL`: it catches `nvim` typed
at a prompt and run by other programs alike, and a dotfile's
`EDITOR=nvim` still reaches it. The script finds the next `nvim` on the PATH
and runs it with the person's arguments, in the pane, as `nvim --embed
--listen <socket> args…`: the pane's environment (`GIT_*`), cwd, exit status
and life are a TUI's; only who draws it changes. `--embed` waits for the UI
before reading the config or a file, so a swap-file question or a config
error is shown, not answered blind. Neovim 0.9 waits for an `--embed` UI on
stdin alone and answers nothing on its socket meanwhile, so there it starts
`--headless` instead, without that wait. It runs the real `nvim` untouched
outside a DevHub terminal (no `$TMUX_PANE`, a session that is neither a
Workspace's `ws-` nor an Agent terminal's `tm-`), with the editor not
Neovim, inside a DevHub GUI Neovim (`$DEVHUB_NEOVIM_GUI`), with stdin
or stdout not a terminal, for non-editing arguments (`--headless`, `-es`,
`--remote*`, `--version`, `-`…), and when no UI attached within ten seconds
(the terminal is not on screen): then the waiting Neovim is ended and the TUI
runs with the same arguments.

**How DevHub learns of it: tmux, not a socket of its own.** The script names
its socket in a pane option of DevHub's own tmux server (`@devhub-nvim`) and
waits for `@devhub-nvim-ui = 1`, which DevHub sets once its UI is attached.
That channel is the same here and on a host and needs no Node, no `devhub`
command and no forwarded control socket over there; the socket itself is
forwarded like the managed Neovim's (`ssh -O forward`). The `devhub-nvim`
window's pane names its Neovim's socket in the same option, which is all it
takes for it to be drawn the same way. The server option
`@devhub-nvim-overlay` says the editor is Neovim, so switching to VS Code
reaches panes that already have the shim. While the script waits, tmux's
`pane_current_command` would say `sh`, which DevHub counts as an idle shell;
every pane reading DevHub makes says `nvim` for a pane with `@devhub-nvim`
instead, so closing the terminal still asks first.

**Where the overlay goes** (`main/editor/terminalNeovims.ts`). While a
terminal is on screen — a Workspace's in the editor area (`pane.html#ws:<id>`,
its `ws-` session), an Agent's beside it (`tm-`), both at once in a split —
its session is read every 150 ms (400 ms on a host):
each pane's cells, which window and pane are active, zoom, modes, the socket
option, and DevHub's client's size, key table, prefix and status line. tmux
pushes none of a window switch, a zoom, `swap-pane` or a resize to anyone
but the client, and one `list-panes` and one `list-clients` read all of it.
The terminal page reports where xterm's screen is (`shell/pane/screenReport.ts`);
the client's size in cells divides it, so the overlay is the pane's exact
rectangle in the terminal view, a `neovim.html#tnv:<n>` view placed right
above it (`ShellWindow.syncTerminalNeovims`). It is hidden while tmux does
not show the pane: another window, a zoomed sibling, copy mode or a chooser.
A terminal not on screen is not read; its overlays keep their pages, hidden.
Each Neovim is its own: a `nvim` run in a pane is never the `devhub-nvim`
one and never reused — `devhub <file>`, a conversation's file link and Send
to Agent go to the Workspace's `devhub-nvim` window, and a `git commit`
waiting on a terminal's Neovim gets no other file.

**The keyboard.** The overlay has the keys whenever its terminal would and
its pane is tmux's active pane, shown. DevHub's chords are caught first, as on
every page. The tmux prefix typed in it is tmux's: DevHub puts its client in
the prefix table (`switch-client -T prefix`) and the terminal takes the next
key; once that binding ran (a zoom, a pane switch, a window switch), the keys
come back if the overlaid pane is still the active one. A binding that opens
a prompt or a chooser (`:`, `[`, `w`, `s`, `,`…) keeps them in the terminal
until Enter or Escape. A click beside the overlay gives the keys to the
terminal; a key typed there that tmux would only hand to the pane under the
overlay (whose Neovim does not read its tty) moves them to the overlay, that
key included. Moving into the pane by tmux brings them back; `:q` ends the
overlay and the keys are the shell's again. A file DevHub opens takes them
back for the `devhub-nvim` window's Neovim, wherever they were. Over the
Workspace's terminal the overlay is the editor half (`Cmd+Q E`, `Cmd+Q O`);
over an Agent's, that terminal.

**What tmux writes into the pane is that Neovim's input**
(`main/editor/terminalNeovimTtyKeys.ts`). The prefix twice (`bind C-q
send-prefix`), a `send-keys` binding, `paste-buffer`, a `devhub tell` typed
into the terminal: tmux writes those into the pane's tty, which the Neovim
does not read. So once DevHub's UI is attached the shim puts the tty in raw
mode and runs a bare `nvim -l` beside it that reads the tty and hands each
key to the Neovim over its socket — `nvim_input` in `<>` notation (`\x11`
is `<C-q>`), a bracketed paste as one `nvim_paste`. Like Neovim's own TUI it
asks tmux for bracketed paste (which `paste-buffer -p`, tmux's `]`, honours)
and modifyOtherKeys (honoured with `extended-keys on`), and reads every
encoding tmux answers with: legacy bytes, CSI u (`extended-keys-format
csi-u`), xterm's `CSI 27;m;c~`, cursor and function keys with modifiers, ESC
before a key as Alt. It is the shim's own doing, so it works the same on an
SSH host, and nothing comes twice: keys typed in the overlay go over RPC, and
a key the terminal page would hand to the pane is taken from the page. When
the Neovim exits the shim ends the reader and gives the tty and tmux's modes
back before it exits with the Neovim's status.

Limits: DevHub's terminals only (an Agent's own pane, `ag-`, gets the TUI);
nothing drawn by tmux over a pane (`display-popup`, `display-menu`) shows
over an overlay; a binding of the person's own that opens a prompt is not
known as one; in bash or fish, a startup file that puts another `nvim`'s
directory in front of the PATH shadows the shim.

**zsh keeps it first.** A startup file that puts Homebrew's directory in
front (`export PATH=/opt/homebrew/bin:$PATH`, `brew shellenv`, macOS's
`path_helper`) would put Homebrew's `nvim` ahead of DevHub's. So a pane's
zsh is pointed at DevHub's own `.zshenv` first (`ZDOTDIR`, beside the shim):
it gives `ZDOTDIR` back at once — the person's, or none — and sources the
person's `.zshenv`, so zsh reads every file of theirs where it always would,
and it adds one `precmd` hook that puts the shim's directory back in front of
the PATH before each prompt if anything moved it. A zsh started from the pane
is an ordinary one.

**`:restart` (Neovim 0.12).** `:restart` starts a new server with the old
one's arguments — the same `--listen` socket — tells its UIs `restart`
(`["restart", listen_addr]`), restores the session and exits. DevHub
follows it wherever a Neovim lives, and nothing on screen leaves:

- _The UI_ (`neovimUiSessions.ts`): after a `restart` event, the old
  connection closing is not an end. The UI connects again to the same
  local socket (on an SSH host, the same `ssh -O forward` socket, which
  reaches the host's path anew), tried every 100 ms for up to 10 s, and
  attaches at the page's current size with the same page. Where the new
  stream starts it puts DevHub's own redraw event `devhub_restarted`
  (`NEOVIM_RESTARTED_EVENT`), on which the page's reducer forgets the old
  server's grids, windows and highlights (keeping its colours) in order
  with the new server's first events: the old frame stays until the new
  server's first `flush`, so there is no blank frame, no shell and no TUI
  between. The overlay, its pane, its placement and the keys are not
  touched; main hears nothing (no `ended`). The old server's GUI windows
  are closed on the page.
- _The pane_ (`neovimRestart.ts`): the new server is the old one's child,
  not the pane's, so whatever waited on the old one would see it exit 0 —
  the shim would give the pane back to the shell and `git commit` would go
  on with the message unedited; the `devhub-nvim` window would close. So
  the shim and the `devhub-nvim` window's keeper (now a `sh` around the
  headless Neovim) put a directory of their own in the server's
  environment (`DEVHUB_NVIM_STATE`, which the restarted server inherits);
  DevHub's setup writes the server's pid there at every attach and, at
  `VimLeave`, `restart` (`v:exitreason`) or the status (`v:exiting`). After
  the first server exits, the program waits on each restarted server by
  its pid and ends with the last one's status: `:restart` then `:wq` in a
  `git commit` makes the commit, `:cq 3` after a restart is status 3.
- A `devhub-nvim` Neovim that restarted is adopted again by its socket at
  the next open, as after a DevHub restart (its `$TMUX_PANE` is the
  keeper's, inherited).
- Neovim 0.11 and older have no `:restart` and never write `restart`:
  nothing changes there. Checked on 0.12.6 with the dotfiles' config: in a
  pane (session and splits back, the pane still the shim's), in the
  `devhub-nvim` window (the next `devhub -g` opens in the restarted one),
  and in `git commit`'s editor (`:restart`, then `:wq` commits). Not
  checked over SSH.

## What works

Verified against Neovim 0.9.5, 0.11.5 and 0.12.6 (`neovimUi.real.test.ts`, and a
DevHub run under Xvfb; on 0.11.5 with a real lazy.nvim config: devhub.nvim's
theme, blink.cmp in insert and `:` mode, the snacks picker, fidget): typing,
the cursor and its shapes, scrolling, splits and floats, resize, the completion menu, the command line, tab pages, the clipboard
provider, GUI windows, file opens, reattaching after a
DevHub restart. SSH, against an sshd on localhost (a Workspace on
`ssh:<host>`, Neovim 0.11.5 and the same config on the host): the socket
forward, the attach, and — after the ControlMaster is killed — the page
reconnecting by itself to the same Neovim, its unsaved edit still there
(before the editor area became the terminal; not run again since). Not
exercised in CI.

Terminal-first, in a DevHub run under Xvfb with the dotfiles' config and
settings (Neovim 0.11.5, zsh with Homebrew's directory put first): startup
and a Workspace opened land on its terminal; `devhub -g file:line:col` makes
the `devhub-nvim` window, switches to it and puts the keys in its Neovim;
`:q` goes back to the shell with the keys; `nvim` typed in the Workspace's
terminal is drawn over its pane, and a `devhub <file>` meanwhile goes to the
`devhub-nvim` window and leaves it alone; `git commit`'s Neovim, a `devhub`
open while it waits, the prefix and `l`/`0` between the two, `:wq` making
the commit; a file opened from an Agent's pane (the split, the keys in the
editor half); `Cmd+Q O` between the halves; resize; switching Workspaces;
`exit` in a session's last shell (attached again); a DevHub restart (the
`devhub-nvim` Neovim adopted, its unsaved edit drawn).

## Limitations

- Dev containers: refused with a sentence.
- No delivery of `nvim` to hosts; Neovim 0.9 or later is expected.
- `ext_messages` off (see The attach and item 6 of the survey); messages
  are Neovim's own, in its message grid, which DevHub draws as a panel
  when they scroll over the windows. 0.12's `ui2` takes the command line
  from DevHub's palette: leave it off in DevHub.
- A GUI window's web page gives `<C-w>` to Neovim.
- Pixel scrolling inside a line taller than the window turns
  `smoothscroll` on for that window until the view leaves the line
  (`:set smoothscroll?` says so meanwhile); a window `scrollbind` moves by other rows than the wheeled one (one side
  at its end) shows what it has, nearest the wheeled one's offset.
- A view is laid out by the browser and scrolled in pixels; Neovim's own
  `topline` in that window is not what is shown (only the cursor line
  is). Items are all drawn (no virtualisation; a view keeps its first 5000
  lines).
- An inline card's height is whole rows: up to a row of its slot is blank
  under it.
- Two images under one line are placed at its first virtual row, one over
  the other.
- Notifications sit above the lowest window's status line, over whatever
  is there (a panel's hint line included), each line on the editor's
  ground.
- A popup carries the highlights its caller adds to a markdown float's
  buffer only where they fall on fenced code (signature help's active
  parameter); one on prose is not drawn. A plain text float's (a
  diagnostic's) are carried.
- No semantic styling of diagnostics yet (`ext_hlstate` names the groups,
  only fillers and `~` use them).
- A GUI buffer shown in two windows has its content (one page) in one of
  them — the current window when it is one, else the
  first — and the other says where it is; a click there moves the cursor in.
- A `devhub-nvim` window started by a DevHub from before the terminal
  became the editor area has its status-line entry made empty; it is
  adopted as it is, and one started from now on is an ordinary window.
- An SSH host's dropped connection takes the overlay with it while the
  Neovim runs on; it is drawn again at the next file opened into the
  Workspace (a pane's own `nvim` there stays undrawn until it exits).

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

**The completion menu** (round 7, the person's pick). Both menus — DevHub's
own (`ext_popupmenu`: a native completion, `<C-x><C-o>`) and a plugin's
float (blink.cmp, nvim-cmp) — say the same things the same way:

- _Candidates_ stay in the editor's face, on the editor's line: a word is
  the text that will land in the buffer, so it looks as it will there. The
  menu sits three cells left of its anchor (padding, mark, gap), so a
  candidate lies over the word it completes.
- _Kinds_ are vector marks (`kinds.ts`), not Nerd Font glyphs or letters:
  eight shapes for LSP's twenty-five kinds — `∧` a callable (an action),
  `●` a value, `○` a variable (a place a value goes), `□` a field (a slot
  of a structure), `■` a type (the structure), `–` a keyword, `◇` a
  module, `⋯` a snippet (text with gaps), `=` text. Eight are learnt at a
  glance; a glyph per kind at cap height is a puzzle. A mark is a cap
  height square on the baseline, as tall as the capitals beside it, its
  stroke a tenth of it. Its colour is the person's: `BlinkCmpKind<Kind>`,
  else `CmpItemKind<Kind>`, else the treesitter group the kind's words
  wear in the buffer (`@function.method`, `@constant`, …). A plugin group
  that is only its generic group (blink links every kind to one
  `BlinkCmpKind`) says nothing about the kind and is passed over. In a
  plugin's float a kind glyph is known by the person's own table
  (blink.cmp's `appearance.kind_icons`, read once blink is loaded — never
  loading it), not guessed from the glyph; other icons stay glyphs.
- _Labels_ (the kind's name, `PmenuKind`; the item's source, `PmenuExtra`;
  `*Sel` on the selected row) are in the UI face a step under the
  editor's size: words about the word, not code.
- _Shape._ The menu is a popup in the floats' radius (6 px, a third of
  the default line). Its selection is a band rounded concentrically: inset
  half the radius (3 px) and rounded by the rest (3 px), the menu's own
  shape smaller, as Zed's; VS Code's square band in a rounded widget is two
  shapes. In a plugin's rounded float the selected row (a row whose every
  cell has a ground other than its neighbours') is drawn the same way,
  inset where the row's end cells are blank (blink's padding), else
  edge to edge with the float's radius. Colours are `Pmenu`/`PmenuSel`.

**Review threads** keep their card (a raised, rounded card with clear
buttons — the person preferred it to a flat band with quiet key hints).
Round 7 took away the coloured, thicker stripe on its left: the state is
the label in its header (and in the panel's list), so the stripe said it
twice and broke the card's one border. No other DevHub card drew one; a
plugin's own `ui.card{ accent = … }` still can.

**Toward a GUI editor: what still looks like a terminal.**

_The principle (binding since round 5, restated in round 7)._ Neovim is
the modal editing engine — buffers, modes, motions, keymaps, layout,
plugins' logic; DevHub is its presentation. The goal is not VS Code's or
Zed's feature set, and none of their clutter: it is to remove everything
that still looks like a terminal — the compromises cells force on
expressing things simply — and to render what Neovim and the person's
config express, faithfully and more precisely. VS Code, Zed and other
modern editors are the normal reference for how a GUI editor draws a
thing; DevHub adds no features and no adornments of its own. Simple,
quiet and beautiful: nothing competes for attention or interrupts
thought. Every design decision states its meaning — the intent it serves,
in terms of the editor's own metrics and highlight groups — and is
recorded here; "VS Code does it" or "looks modern" is a reference, not a
reason. A matter of taste is mocked first and the person picks.

- Do: draw what cells only approximate as what it means — a separator as
  a true line between two grounds, a selection as a continuous fill with
  no seam between cells, `~` past the end left out, a diff's filler
  hatched, box drawing and Powerline glyphs as crisp geometry, a float's
  border as a line with the editor showing through its gaps, underlines
  and undercurl as a typesetter strokes them. Proper vertical centring and
  bar height in status lines.
- Do: draw the main window's own marks as the person's highlights say —
  selections, matches, the cursor, status line and winbar runs, virtual
  text, `MatchParen`, tabs, the message panel — as round 5 left them.
  Floats and popups are rounded (they are lifted off the window), and what
  is inside a rounded element follows its rounding (a menu's selected row).
- Do: soften only what is high in volume and transient and would draw too
  much attention if crisp (fidget's progress). Anything persistently just
  there stays crisp — truncated lines, hovers, floats, menus, the status
  line's filename, the message panel: blurring what is always there makes
  the whole editor feel blurred and costs focus.
- Don't: reinterpret the person's design (pills in their status line,
  Powerline separators turned into gaps), add what their config does not
  ask for (fold chevrons, indent guides, scrollbars and overview marks of
  DevHub's own, a box around the matching bracket, a lit sash), or wrap
  quiet information in cards, hairlines and shadows (a notification
  centre).

History: geometric box drawing, blocks and Powerline separators; floats
framed, cut at their line, titled with labels; panels of floats under one
shadow; native popupmenu, command line, tab line, hover popups,
notifications; smooth scroll and cursor; then rounds 1–4 by the list
below, measured against VS Code and Zed. Round 5 re-judged all of it by
the principle and took back what it rules out (struck through below).
Verified on 0.11.5 and 0.12.6 with a real config (splits, floats and
panels, the command line, the completion menu, IME preedit, `:terminal`,
diff mode, folds, CJK, `linespace`): a full-window scroll costs what it
did before. Round 3 again on both, with the wheel over splits, diff
(`scrollbind`), floats and the command line, in Insert mode and in
`:terminal`; wheel to screen, measured in the page under Xvfb: 0.1–2 ms
while Neovim's lead covers it (the display moves in the wheel's own
event), one round trip (10–40 ms) for the first line of a gesture, against
20–100 ms per step before.

Round 4 made pixel scrolling exact beyond the text itself and held it up
under real conditions. What sits on the text (inline images and cards,
decorations, `gui.popup`s, floats at a buffer position) now rides it
frame for frame (`riders.ts`), checked by a probe that compares, every
frame the page draws, each rider's place with its line's row in the
painted grid: 0 misplaced of about 3 400 checks over slow, fast and
reversing gestures (before: a line or two off through each gesture). The
wheel leaves the cursor where Neovim's own would (it was pushed up to
Neovim's lead further, several lines on a flick). Wrapped lines (a line
taller than a row moved by all its rows, and the settle snapped back to
the top), a busy Neovim (a file just opened: requests timed out, were
sent again, and Neovim scrolled by all of them — 1 800 px for a 270 px
gesture), flicks (the display stalled up to 10 rows behind the wheel,
then jumped: now 2–5) and `scrollbind` (the bound window eased
behind, up to 280 px apart: now 0 px apart in every frame) were fixed;
folds, splits of one buffer, `:terminal` and a 260 000-line file held.
Measured with momentum-like wheel deltas (a flick decaying from 36 px a
frame, fractional tails, reversals) on 0.11.5 and 0.12.6. Two direction
changes, recorded: placements were first stamped with the `topline` Lua
counted from, which cannot tell a scroll through filler or virtual lines
(the topline stays, `topfill` changes) — the page now counts a placement
from the rows it had heard of when it came, and Lua draws what is owed
before placing (`M._drawn`); and scrollbound windows were to fall back to
line scrolling, which proved unnecessary once they follow the wheeled
window's offset. Sticky scroll was left out: the config has no
treesitter-context, and a header of DevHub's would have to guess at
scopes Neovim does not report; the cursor's glide (70 ms) was already
there.

Round 5 finished pixel scrolling's edges, then — on the person's word —
re-judged everything by the principle above. Kept and added: a float at a
buffer position whose line Neovim, led ahead, has scrolled out of its view
(Neovim pins it to the window's top edge) stays on its line while the
display shows it (`pinnedRows`; a probe comparing the float with its
line's row every frame: 0 off of 100–180 frames per gesture on 0.11.5 and
0.12.6, against every frame past the line before); a line taller than the
window scrolls a row at a time (`smoothscroll` set on that window while
its view is inside the line, the person's value back once it leaves, its
buffer leaves the window, or a window is split from it; before, the
display jumped 1 700 px at once); a drag from a window border or status
line resizes (it stopped at the first window it crossed), with a resize
pointer and nothing lit; tabs keep their names and the strip scrolls,
bringing the current tab into view on `gt`; underlines and undercurl drawn
as type is (`strokes.ts`); notifications back to fidget's quiet lines.
Taken back: DevHub's window scrollbar with its overview marks (and the
clickable marks, paging and thumb drag built for it this round), rounded
selections and matches, status line pills and Powerline gaps, virtual
text pills, the `MatchParen` box, fold chevrons, the guide restyling, the
message panel's hairline and shadow, rounded cursor and tabs, a lit sash,
notification cards, and hover markdown's heading sizes and quote bar.
The person's status line now matches a plain terminal's rendering of
their config (xterm, checked side by side) except where the terminal
compromises: glyph geometry and centring. Re-checked together on a fresh
build, 0.11.5 and 0.12.6: riders with notifications and the message panel
(0 misplaced of 635 checks), pixel scrolling with an IME preedit, a Visual
selection and through a diff (`scrollbind`, filler hatched, both sides in
line), floats, the picker, the command line, blink, `:terminal`, folds,
CJK and `linespace`. Round 6 mocked the rest; round 7 built the person's
picks (notifications, the completion menu, review threads above) and
checked them on 0.11.5 and 0.12.6 with the person's config. The audit's
flat `gui.view` panels were declined (the current panels stay); its
`ui.*` card proposals are undecided (the "TERMINAL NORMAL" pill went with
`:DevhubTerminal`: the Workspace's terminal is the editor area itself, so a
terminal inside Neovim is no longer offered; Neovim's own `:terminal` is a
grid like any other). Proposed, not built (mocks first, the person picks):
a feathered translucent backdrop behind fidget's lines, a fold's fill as
a fading hairline when its fill character is a line (built in round 8),
a very short slide of the lines `dd`/`p`/`o` move (built in round 8,
60 ms).

Round 8 built: decorations in a proportional face (virtual text, inlay
hints, virtual lines, a fold's text; The page), the command line in the
rows `cmdheight` keeps, the fold's line fill as a fading hairline, the
60 ms slide of lines a `dd` or an `o` moves, `:restart`, and fixed a
picker's title row drawn as a band cut out of the selection (a title kept
above a list whose first item is selected). Checked on 0.11.5 and 0.12.6
with the dotfiles' config (`cmdheight=2`), terminal-first, `nvim` in a
pane and `devhub -g`: splits, floats, the snacks picker (its layouts and
`solid`, `rounded`, `single` borders titled left, centre and right), the
command line at both `cmdheight`s, blink after `Math.m`, IME in the
buffer and the command line, `:terminal`, diff, folds, CJK, `linespace`,
keyboard-only, click-through, wheel scrolling, inlay hints (faked with
`nvim_buf_set_extmark`: the config turns the servers' off), typing
before them (no frame falls back to cells).

Candidates, by visual impact and then by compatibility risk (the
least risky first within a band):

1. _Window separators_ (`│` in a whole cell column) — done: each half of
   the column is drawn in the ground of what is beside it (a window's
   commonest colour along that edge — its `Normal`, `NormalNC`, sign
   column — so a cursor line does not bleed in; a status line's cell
   where one is), and the line, already a device pixel or so through the
   middle, is all that is left between: splits meet edge to edge like
   editor groups. A status line drawn as a line beside it (`─`, a
   person's `stl:`) meets that line instead of stopping half a cell short.
   A blank separator (`vert: `) is a band by choice and stays one. Clicks and drags on the column stay Neovim's.
2. ~~_Statusline and winbar as cell rows_~~ — round 1 drew a status line
   as a bar of its commonest colour with the other runs as rounded pills
   and Powerline's separators turned into gaps. Taken back in round 5: it
   reinterpreted the person's design (theirs floats the file name at the
   right on a line). Now exactly what the status line says; only the
   separator glyphs are crisp geometry and the text centred in the row.
3. _Selection, search and cursorline_ — a selection or match is its
   highlight's own fill, square and continuous across cells and
   `linespace` (round 5; rounds 1–2 drew rounded outlines with filled inner
   corners, as VS Code's — taken back). `CursorLine` a flat band.
4. _`~` end-of-buffer markers and the blank rows past the end_ — done:
   while the global `fillchars` has no `eob:` (asked with the theme), a
   window row that is only a `~` in `EndOfBuffer`'s colour is drawn
   without it: empty space past the end, as GUI editors show. A person who
   set `eob:` (even `eob:~`) keeps their markers, per window: the page asks
   each window's `fillchars`, again on `OptionSet fillchars`. The `~` is
   known by its highlight's name (`EndOfBuffer`), not its colour.
5. _Float scrollbars drawn by plugins as cells_ — done for scrollbars
   that are floats (blink.cmp's and nvim-cmp's: one cell wide,
   unfocusable, blank cells in a colour, on a menu's last column or the
   one after it, within its rows — round 2: a plugin's lone one-column
   float elsewhere is left alone): the one with another over it is
   the gutter and is not drawn (the menu's ground shows), the other the
   thumb, drawn as a thin rounded bar in the middle of its cell
   (`floatScrollbars`, a `clip-path` on its canvas). Clicks are as
   before. Thumbs drawn as glyphs inside a float (`█`, `▐`) are left as
   text: telling them from content is a guess.
6. _The message area and `cmdheight` row_ (`-- INSERT --`, the ruler, `Press
ENTER`) — evaluated in round 2, `ext_messages` not adopted. On 0.11 it
   is still experimental and still hands the UI `return_prompt`,
   `confirm`, `confirm_sub` and the swap-file question while Neovim waits
   for a key: a GUI that draws them as toasts must draw every one, with
   its choices, or the person types into a prompt they cannot see; and
   0.9/0.10 (still supported) differ again. 0.12's answer is not a remote
   UI's at all: `ui2` (`require('vim._core.ui2').enable()`) is a Lua UI
   inside Neovim that takes `ext_messages` and `ext_cmdline` itself and
   draws messages, the pager and dialogs in Neovim windows. Tried under
   DevHub on 0.12.6 it takes the command line away from DevHub's palette
   (nothing shows while typing `:`), so it and DevHub's `ext_cmdline`
   exclude each other; once ui2 is the default the way forward is to
   leave messages to it and draw its windows as floats, not to grow a
   second message UI here. What landed instead is safe: messages that
   scroll up over the windows (`msg_set_pos` with `scrolled`: `:ls`, an
   error's trace, a hit-enter or `confirm()` prompt) are a panel risen
   from the bottom and the notifications move above it, so a prompt is never under a toast.
   Prompts are answered by keyboard as before (checked: hit-enter,
   `confirm()` answered with `n`). Round 5 took its hairline and shadow back:
   it is Neovim's message grid, square and crisp.
7. _Sign, number and fold columns_ — ~~fold chevrons~~ (rounds 2–3 drew
   the fold column's `-`/`+` as chevrons, an open fold's only on hover;
   taken back in round 5: an invention). The fold column is what
   `foldcolumn` and `fillchars` say, only when the config asks for it.
   Signs and numbers as Neovim draws them.
8. ~~_Indent guides_~~ — round 3 redrew any guide plugin's character as
   one light line at the cell's left edge; taken back in round 5. A guide
   is the plugin's own character where its config draws it; box-drawing
   characters are continuous across `linespace` as all box drawing is.
9. ~~_Diagnostic virtual text and inlay hints as pills_~~ — taken back in
   round 5: square, as the highlight says.
10. _Diff filler lines_ — done: a row that is, from some column on, only
    `-` in `DiffDelete`'s ground (the default `diff:`) is a hatched band
    of thin diagonals in its foreground, continuous from row to row, as
    GUI diff views mark lines the other side has. A person's `diff:` is
    kept. Folds' `+--  12 lines` stay Neovim's text — `foldtext` is the
    person's, and a fold bar of DevHub's would have to guess at it — set in
    the UI face after the marker (round 8, "Decorations in a proportional
    face").
11. _The block cursor and its cell_ — done: the block is square (round 5; its
    rounded corners were taken back), it still shows the character in the
    cursor's foreground, and the blink (`guicursor`'s) fades in and out
    over 120 ms of its phases, as VS Code's "smooth" blink; a hard blink
    with reduced motion.
12. _Blended backdrops_ — done (round 3): a float of only blank cells in
    one ground with `winblend` (snacks' `backdrop`; its `Normal` and
    `EndOfBuffer` rows are two highlights of one colour) is one element
    tinted with that ground at `100 - blend` percent, no bitmap: the same
    pixels Neovim's compositor mixes (checked against the canvas it
    replaced), without an editor-sized canvas to paint.
13. _Scrolling by whole rows_ — done (round 3): pixel scrolling (The page,
    above). Neovim is led rather than the grid oversized: a window's grid
    stays the size Neovim gave it, and what the display needs beyond it is
    the ghost of what Neovim drew before. `scrolloff` and the last row's
    padding stay behaviour, kept.
14. ~~_Scrollbar marks_~~ — round 4 drew an overlay scrollbar on each
    window with VS Code's overview ruler along it; round 5 made it
    clickable, then took all of it back: DevHub's own invention, not the
    person's. Scrollbars a plugin draws (a menu's) are kept, drawn thin.
15. ~~_The matching bracket_~~ — round 4 boxed `MatchParen`'s cells with a
    hairline, as VS Code's; taken back in round 5: the highlight as it is.
    **Also:** dev containers (Neovim in the container through `docker exec`, its
    socket reached by a relay like the `devhub` command's), delivering `nvim` to
    hosts like tmux and bash are, `ext_messages` on 0.10+, ligatures, a
    glyph-atlas (WebGL) painter if large redraws need it, and the
    Sidebar following the current buffer.
