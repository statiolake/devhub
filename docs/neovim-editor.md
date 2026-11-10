# The Neovim editor: DevHub as a GUI for Neovim

A Workspace's editor area is **its terminal**: the Workspace's `ws-` tmux
session, which is what DevHub shows when it starts and when a Workspace is
opened or selected. Neovim is something opened inside it, and every Neovim there is DevHub's own
GUI for it, drawn through Neovim's UI protocol exactly over its tmux pane:

- `nvim` typed in a pane — of the Workspace's terminal or an Agent's — or run
  by `git commit`, `crontab -e`, `$EDITOR` (see Neovim in a terminal);
- the Workspace's one `devhub-nvim` window, where `devhub <file>` and a
  conversation's file link open (see Integrations).

Neovim owns the buffers, the windows and their layout, the modes, the
plugins and the language servers; DevHub draws, and adds GUI-native widgets
that are attached to Neovim objects and follow them.

It is the only editor there is: the `general.editor` setting that chose
between it and a VS Code workbench is retired with VS Code
(`docs/without-vscode.md`).

There is no editor surface apart from the terminal, no "Editor not running"
placeholder and nothing to start: the terminal attaches as the area is shown,
and a session that ended (its last window closed) is made and attached again
at once — every time, however soon after the last. The pane says it is not
connected only when a session made again ends within 3 s with nothing typed
into it, which is a shell that cannot start. After that reattach, or a Retry
by Return or click, the keys are the terminal's, and keys typed meanwhile
reach the new shell. `:q` ends a Neovim.

## Architecture

```
 pane.html (a terminal's page;           Neovim host (utility process)     the Workspace's machine
  a Neovim per pane, tnv:<n>)
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
`MessagePort` and takes its calls back on it. That page is the terminal's
own (`pane.html`): it holds the terminal and each Neovim over one of its
panes, every UI on it named by its overlay's key on the one port. Main answers the attach (which
Neovim, which socket), hands the port out, and answers the clipboard, which a
utility process has none of. The host is started once DevHub is idle
after launch — the window shown, every page's first paint done, main's
event loop quiet (`shell/launchIdle.ts`, `NeovimHostClient.startAtIdle`) —
so the first `nvim` finds it running; a Neovim named in a pane before then
starts it at once (`prepare`, as the overlay appears), and the idle start
then starts nothing. A build with no Neovim of its own (`out/nvim`) or
`DEVHUB_NEOVIM_IN_MAIN=1` starts none at idle. A host that ends is started
again by the next attach, not eagerly, and the pages
reconnect by themselves; after three ends in a minute, or with
`DEVHUB_NEOVIM_IN_MAIN=1`, the same code (`editor/neovimUiSessions.ts`) runs
in main and the page's calls and redraws are IPC (`docs/process-model.md`,
phase 5c).

### The process

Two kinds of Neovim, drawn the same way:

- **The Workspace's `devhub-nvim` window.** `main/editor/managedNeovim.ts`
  keeps one Neovim per Workspace for the files DevHub opens:
  `env DEVHUB_NEOVIM_GUI=1 <DevHub's nvim> --headless --listen <socket>` with the
  person's own config, cwd the Workspace's folder, in a window named
  `devhub-nvim` of the Workspace's `ws-` session, made the first time a file
  is opened. Each open selects that window and names the socket on its pane
  (`@devhub-nvim`), and the terminal draws the GUI over the pane; the pane
  itself draws nothing (the Neovim is headless). tmux keeps it across a
  DevHub restart and an SSH connection dropping, and the next DevHub adopts
  it by its socket, a digest of the Workspace id.
- **A `nvim` run in a pane**, by DevHub's shim (Neovim in a terminal):
  DevHub's Neovim, with the person's config, as that pane's foreground
  program.

Neither is ever used for the other's job: an open never goes to a Neovim the
person started (a `git commit` waiting on its editor gets no other file),
and `nvim` in a pane never reuses the `devhub-nvim` one.

Each is drawn in its pane by that terminal's own page
(`shell/pane/PaneNeovims.tsx`, `main/editor/terminalNeovims.ts`), with its
own UI connection to the socket (below).

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
- **A host DevHub's Neovim cannot run on** (musl, a glibc before 2.34, not
  Linux on x86_64 or arm64): the open is refused with a notice naming the
  machine and why (Which Neovim, below).

#### Which Neovim

Every Neovim DevHub starts is its own: Neovim's official release, at the
one version `apps/desktop/product.json` pins (`nvimVersion`, 0.12.x, with a
sha256 per archive in `nvimDownloadSha256`). DevHub is written against 0.12
and nothing older: there is no version check, no fallback and no other
Neovim it would take. Whatever `nvim` the person has on the PATH is never
run by DevHub, and nothing outside DevHub changes — a terminal that is not
DevHub's runs the person's own as before.

- **This Mac.** `build:nvim` (`apps/desktop/scripts/fetch-neovim.mjs`, part
  of `build`) downloads `nvim-macos-arm64.tar.gz`, checks its digest and
  unpacks it into `out/nvim` (`bin/nvim`, `lib/nvim/parser`,
  `share/nvim/runtime`); the archive is cached under `~/.cache/devhub/nvim`.
  The packaged app carries it at `Contents/Resources/app/out/nvim`, where
  packaging signs `bin/nvim` and the parsers ad hoc, as it signs the speech
  recogniser (`sign_neovim`, `scripts/package-nightly.py`).
  `editor/bundledNeovim.ts` names it; `LocalRuntime.neovimProgram` answers
  it, and a build without one says so.
- **An SSH host.** The same release for the host's platform
  (`nvim-linux-x86_64`, `nvim-linux-arm64`), fetched on this Mac and
  unpacked on the host under `~/.devhub-server/nvim/<version>` from stdin,
  exactly as tmux and bash are (`RemoteShellRuntime.neovimProgram`,
  `toolDelivery.ts`); the archive is cached under DevHub's data
  (`<user data>/nvim`). Neovim's Linux build needs glibc 2.34 or later, so a
  musl host (Alpine), an older glibc (`getconf GNU_LIBC_VERSION`) and a host
  that is not Linux on x86_64 or arm64 are refused by name before anything
  is sent (`neovimHostRefusal`, `runtime/libc.ts`).
- **Who runs it.** `Runtime.neovimProgram` is the one answer: the
  `devhub-nvim` window's keeper runs it by its absolute path, and the shim
  has that path written in. The tests that need a real Neovim run the
  bundled one too (`editor/testNeovim.ts`), on CI and in
  `scripts/test-local.sh`.
- **`$VIMRUNTIME`.** Neovim finds its runtime beside itself
  (`<nvim>/../share/nvim/runtime`), so the keeper and the shim unset an
  inherited `VIMRUNTIME` and `VIM` (another Neovim's, say a `:terminal`'s)
  before they start it: `:echo $VIMRUNTIME` is the bundle's.
- **Plugins.** `stdpath()` is the person's as ever (`~/.config/nvim`,
  `~/.local/share/nvim`), so a lazy.nvim setup, its installs, the
  parsers a plugin downloads and its build steps are what they were. A
  build step that runs `nvim` gets the shim (the pane's PATH), which runs
  the same Neovim; `v:progpath` is the bundled one.

### The attach

`main/editor/neovimUi.ts` attaches with `rgb`, `ext_linegrid`,
`ext_multigrid`, `ext_hlstate`, `ext_popupmenu`, `ext_cmdline`,
`ext_messages` and `ext_tabline`. `ext_hlstate` only adds the groups each highlight is made of
(`hl_attr_define`'s info: `ui_name`, `hi_name`); the page keeps them on the
highlight and knows the end-of-buffer `~` by name, not by colour.
`ext_messages` hands DevHub Neovim's messages, prompts, mode and ruler as
events, and DevHub draws them (Messages, below); Neovim 0.12 has no
hit-enter prompt for such a UI and asks every question through the command
line, so nothing waits on a screen DevHub does not draw. Before attaching
it runs a Lua snippet (`SETUP_LUA`) that:

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

**The first attach** is a Neovim's first UI: an `--embed` Neovim (a pane's
`nvim`, the new server of a `:restart`) waits for it before it reads the
config or opens a file. It is attached to once, at its pane's size: the
config runs and the windows are laid out at the size they are drawn at, and
Neovim's first screen is the page's first frame. The setup above is one
request (`nvim_call_atomic`: in order, each part only after the one before
it succeeded, one round trip, which over SSH is one to the host).

**Attaching again** (a reloaded page, a restarted DevHub) needs care: Neovim
keeps its window grids and assumes a new multigrid UI has them too. So the
attach is preceded by a moment attached without multigrid (at another size),
which frees them, and a window Neovim does not place again is placed from the
layout Lua reports. That moment fits every tab's windows into the other size,
and growing back spreads the rows anew, so each tab's sizes are kept before it
(`winrestcmd()`) and put back once attached, scaled to the rows and columns
there are now and with the person's `cmdheight` put back after: `:resize` at
the old, smaller size (an `--embed` Neovim's first 80x24) would give the
difference to the command line, not the windows. A Neovim attaches only once
the terminal surface has put its element on its pane, at the pane's size
(`placed`): an element not yet placed is no pane's size, and a UI attached at
it reshapes the windows the same way. A page that loads again lets go of its
old UIs and its port to the Neovim host, which died with its old document,
and each Neovim on it attaches anew. A Neovim stopped at a prompt is let out
of it first.

### The page

`shell/neovim/`, mounted by the terminal's page (`NeovimSurface`, one per
Neovim, in `shell/pane/PaneNeovims.tsx`). What every layer of it is held to —
its own element, clip, z-order and opaque canvas — and where the code still
falls short: `docs/rendering-layers.md`.

**Its failures are its own.** It shares the terminal's renderer with the
terminal and the other Neovims there, where it had a renderer of its own.
What is per Neovim stays per Neovim. Its UI's end (Neovim exited, the host
restarted, an SSH drop) is shown in its pane, with Retry or a reconnect by
itself. A redraw it cannot apply is caught, and that Neovim starts over
with a new attach. A render that throws is caught by its pane's error
boundary, which offers Retry. Its UI runs in the Neovim host, as before, so
a Neovim whose RPC dies or floods takes down the host at most, never the
page. Every Neovim then reconnects. Checked in the app: a pane's Neovim
killed (`kill -9`) leaves its pane to the shell and the other Neovim and the
terminal as they were; the Neovim host killed, both Neovims reconnect and
take keys. What is not isolated any more is the renderer process itself:
a crash of the terminal's renderer (out of memory, a GPU fault) takes its
Neovims with it. The page is reloaded (`supervisePage`), its Neovims attach
again, and the Neovims themselves run on in tmux. That trade was taken for
one layer model and pane motion.

- `redraw.ts` — the pure reducer: `grid_resize/line/clear/destroy/scroll`,
  `grid_cursor_goto`, `win_pos/win_float_pos/win_hide/win_close`,
  `win_viewport`, `hl_attr_define`, `default_colors_set` (with
  DevHub's theme for `-1`), `mode_info_set/mode_change`, `option_set`,
  `busy_start/stop`, `flush`, the popupmenu, command line and tab line,
  and the messages (`msg_show`, `msg_clear`, `msg_showmode`, `msg_showcmd`,
  `msg_ruler`, `msg_history_show`; `messages.ts` routes them).
  `layoutGrids` stacks the grids: grid 1, the windows, floats by `zindex`
  against their anchor grid. The message grid (`msg_set_pos`) is not laid
  out: with `ext_messages` Neovim draws nothing in it.
- `painter.ts` — a 2D canvas per grid, repainted a dirty row at a time on
  the animation frame after a `flush`; runs of one highlight, wide characters
  cell by cell, underline/undercurl/underdouble/dotted/dashed/strikethrough in
  the special colour, `reverse`, float `blend`. A float is drawn as
  Neovim sends it, in one frame of DevHub's ("Floating surfaces", below):
  its content is its cells, monospace and plain, where Neovim put them,
  and whatever its border (`'none'`, `'solid'`, `'single'`, `'rounded'`,
  `'double'`, a table of characters) the frame is one 1px rounded line
  half a cell from its text, the ground between them the border's own
  (`frame.ts`, `GridBox.frame`). Neovim says where a border is with
  `win_viewport_margins`; its line is centred on the middle of the border's
  cells, across and down, on whole device pixels rounded to the nearest
  (`lineSpan`: no floor or ceil, so no ratio or row height moves it one
  way), the title's text centred on it; nothing of the cells outside it drawn — the windows behind show there,
  and a click there goes to them. A float without a border is padded as
  much outside its cells; a panel where such a float is next to the
  cursor's row (a completion menu under the line being typed) is drawn
  half a row off it, so the padding never covers what is typed
  (`clearCursorRow`; a click is read back by the pixel). Floats are over
  the windows: a window's boundary inside the editor never cuts a frame.
  The editor's own edge does (its clip, or a tmux pane's border past its
  half cell), so a panel whose frame would go past it — a cmdline menu at
  column 0, a float on the first or last row or column — is drawn a whole
  cell in from that edge, its line through the middle of the edge cell as
  a bordered float's is, its text still on whole cells (`clearEdges`; a
  panel that cannot clear both edges of an axis, or was moved off the
  cursor's row, stays on that axis). The `title` and
  `footer` are the cells Neovim put in the border, its blanks too, on the
  line where Neovim put them (`title_pos`/`footer_pos`), the line broken
  under them: the page asks `nvim_win_get_config` when a border holds
  text, and when the config does not explain that text the float is
  drawn cell for cell, as Neovim drew it. A float that opens with text in
  its border is drawn once its answer has come (`LabelAsks`: the flush
  that opens it waits for it, every float of a panel together), so its
  first frame is its final one, not the cell-for-cell frame snapping to
  the line a moment later; a later change of that text is asked again and
  drawn as it comes, so a float never waits on itself twice. A border wider than
  a cell or with text in a side is drawn as Neovim says, with only a
  shadow: never two frames (`floatBorder`). Floats edge to edge (or a
  cell apart) at about the same `zindex` are one panel — a picker's input,
  list and preview (`floats.ts`'s `floatClusters`): one shadow under the
  union of their frames (an element of grounds per cluster, under the
  canvases, with the floats' `drop-shadow`), only the panel's outer
  corners rounded; a float alone is a panel of one, and one with
  `winblend` gets none. The edge members with borders share is drawn once
  (`framePieces`), the two border cells that touch fused into one line:
  through the middle of the one that holds a title or footer there (a
  list's title under the input sits on the line), else at the middle of
  the two cells together — the edge they share, leaning to neither side
  — on the nearest whole device pixel, each member's ground meeting the
  line from its side; members without one meet ground to ground, a one-cell seam between them filled
  with their ground. A borderless float inside the rectangle the framed
  floats over it span (a picker's root box) has no frame of its own and
  is clipped by them (`frameCuts`, `cutClip`): drawn where no frame is
  over it and inside their lines, never in the half cell outside a line.
  With `winblend`, the ring between the line and the text is blended and
  the panel has no shadow. Ligatures off. The font is the terminal's —
  `[appearance] terminal_font_family`, `terminal_font_size` and
  `terminal_line_height` (Settings > Agent panes), one source for the
  panes and every Neovim DevHub draws (`cellFont.ts`) — so a Neovim's cells
  are its pane's and its rows line up with the terminal's around it.
  A config's own wins for its Neovim: a `guifont` that is neither empty
  nor Neovim's own default gives the faces and the size (since 0.12 the
  default is a list per platform, `SF Mono,Menlo,…` on macOS; taken for the
  person's, it put every Neovim in SF Mono or Menlo beside panes in the
  terminal font — `NEOVIM_DEFAULT_GUIFONTS`), and a
  `linespace` above 0 (the default) is the pixels between rows in place
  of the line height, the font's line box plus that many. Both are
  followed as Neovim sends them, so `:set guifont=…` or a font-size
  mapping applies at once and `:set guifont=` hands the grid back to the
  terminal's font. A config that sets them only for other GUIs keeps them
  out of DevHub with `$DEVHUB_NEOVIM_GUI`.
  - The row is the terminal's (`cellMetrics`, `terminal-mode.md`, "The
    font, once"): the line box on device pixels times the line height,
    floored, the extra shared above and below it.
  - What DevHub sets in the UI face (hovers, views, toasts, the tab strip,
    badges, pills, keys, decorations' words) takes one type scale from the
    grid's size (`uiTypeScale`): text at it, labels a step under, small
    capitals and key caps two under, code in the grid's face at the grid's
    size; one family list (`--nvim-ui-font`, the painter's `UI_FAMILY`).
  - Every grid, floats included, is an opaque canvas, so its text is set
    with subpixel antialiasing (CoreText's font smoothing on macOS), which
    Chromium does only on an opaque canvas; only a float with a `winblend`
    cell has alpha (`gridBlends`). Floats had alpha whether they blended or
    not, and every hover, menu and picker was set in grayscale.
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
    else. An icon is put in its cells as Ghostty puts the Nerd Font icons
    (`placeIcon`, its `fit_cover1` and `center1`; the editor's grids and
    the terminal panes alike): the font's em square, which every icon of
    the Mono font is drawn in, scaled to one cell across and the patcher's
    icon height alone, or to the face's height across two cells when
    Neovim says it is wide or a blank cell of the same background follows
    it (devicons, lualine and completion menus all put a space after their
    icons); centred on the first cell, or from its left edge when wider,
    and centred down on the face, which is centred in the row. A sign's
    two cells are the sign column's (`SignColumn`, `CursorLineSign` in
    `ext_hlstate`'s names): a sign is centred across both, an icon or a
    letter. Powerline Extra separators (U+E0C0–E0D7) are stretched to the
    whole cell. A completion kind that starts
    with an icon (lspkind) shows that icon in the popup menu.
  - Selections and search matches are their highlight's own fill, square
    and continuous: the whole cell, `linespace` included, with no seam
    between cells or rows (a terminal's grid shows one).
  - Windows are panes with a boundary between them, as VS Code and Zed
    show editor groups — not separator cells, a TUI's artefact of the
    cell grid (`boundariesOf`, `placePanes`; docs/rendering-layers.md,
    "Panes and boundaries", has the rule). A window and its status line
    (`laststatus` 1 or 2) are one region; regions meet at one hairline in
    `WinSeparator`'s ink on the middle of the gap cells, joined at T and +
    junctions, and each region's ground goes on to it: the window's rows
    continue sideways in their own edge cells' grounds (its `Normal` or
    `NormalNC` through `winhighlight`, a current line, a diff line), its
    pane in its own ground above and below. With `laststatus` 0 or 3,
    stacked windows meet at a hairline across the separator row. A status
    line drawn as a line (`─`, a person's `stl:`) beside a boundary meets
    it, and a boundary ending on its junction (`┴`) ends on its line. In a
    tmux pane, the editor's rows, its windows' and its tab strip reach
    into the pane's half border cells to tmux's line. Earlier rounds
    painted the column into grid 1's canvas with each half in the
    commonest colour of the window beside it, which a diff hunk scrolling
    past flipped; then each pane in its `Normal` alone, which left a
    half-cell strip of it beside a current line, a sidebar's own ground,
    a sign column, a status line's label, and (in a tmux pane) beside the
    tab strip and every row on the pane's edge.
  - The `~` past the end of a buffer (in `EndOfBuffer`) is not drawn while
    the window's `fillchars` has no `eob:` of the person's
    (`isEndOfBuffer`); a `:setlocal fillchars` is seen at once
    (`OptionSet`, and on `FileType`/`BufWinEnter` when a window's differs).
  - Diff mode is what Neovim draws, cell for cell: `DiffAdd`,
    `DiffChange`, `DiffText` and `DiffDelete` where Neovim puts them
    (`DiffChange` to the window's edge, as Neovim extends it), and a
    filler row's `fillchars` `diff:` character (`-` by default) as text.
    How a changed line and its changed text look is the colorscheme's.
  - A menu's scrollbar made of one-column floats (blink.cmp, nvim-cmp) on
    a menu's right edge is an overlay scrollbar inside the menu's frame:
    its column is the frame's right padding, the line along its outer edge
    (`scrollbarLine`), the gutter not drawn, the thumb a thin bar in the
    padding — not a strip half outside the frame with the line through
    the thumb.
  - Status lines, winbars, folds (a closed fold's `foldtext` and its
    `fold:` fill, the fold column's marks), indent guides and
    `MatchParen` are what Neovim and the person's config say, cell for
    cell; only the glyphs a terminal approximates are drawn as what they
    mean (box drawing, blocks and Powerline separators as geometry,
    continuous across `linespace`).
  - Decorations in a proportional face (`decor.ts`,
    `main/editor/neovimDecor.ts`): virtual text at the end of a line
    (diagnostics, git blame), right-aligned and inline (inlay hints), and
    virtual lines are not the buffer's content, so their words are set in
    the UI face a step under the editor's size, as the completion menu's
    labels are: words about the code, not code.
    Does Neovim drawing them on cells make them drift? No, as long as they
    stay inside their cells. Neovim lays them out in cells, and everything
    after them — the buffer text after an inlay hint, the cursor, a
    click's cell, a selection — is placed by those cells, not by what the
    GUI draws in them. A proportional word is usually narrower than its
    cells, so it is drawn inside them and the slack is left blank; one
    wider (rare) is set narrower to fit, never past them. What cells cannot
    say is _which_ cells are virtual: `grid_line` does not tell. So Lua
    says: after every redraw that drew a window, the extmarks in its
    visible lines (`nvim_buf_get_extmarks` with details) are placed with
    `screenpos` and sent as rows and columns of the window's grid with
    their text (only when they changed). The page sets one only where the grid holds exactly
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
    - Left as cells: `overlay` and `virt_text_win_col` text (put on the
      buffer's own columns — indent guides, tables, concealed markup —
      it only works on cells), `virt_lines_above`, and a closed fold's
      line (its `foldtext`, as Neovim draws it).
    - Left as cells too: every plugin's virtual text and lines. Only
      Neovim's own standard features (namespaces `nvim.*`: diagnostics'
      virtual text and lines, LSP inlay hints and code lenses) and
      DevHub's own (`devhub*`) are set in the UI face: they are what
      DevHub restyles on purpose. A plugin's (an inline diff's deleted
      lines, a blame line, a hunk preview) is its content, shown as it
      drew it, as a plugin's float is; neither side declares anything to
      the other, and guessing from highlight groups would be wrong as
      often as right.
    - Wide characters take their two cells in the match; a CJK word in a
      proportional face is about as wide as its cells.
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
- A window scrolls in pixels (`smoothScroll.ts`; Neovim says how far
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
  message grid, and with reduced motion only the wheel's own
  movement.
- Lines a `dd`, `p` or `o` moves slide into place in 60 ms (the
  person's pick of three mocks, round 6: 0, 60, 100 ms): what was
  deleted closes up, what was put in opens a gap, so the eye sees where
  the lines went. It is told from Neovim's own redraw: a `grid_scroll` in
  a window whose `win_viewport` says it did not scroll, at most a
  third of the window, one per frame. An image of the region as painted
  moves inside a clip of it (`slideLines`); the canvas under it is already
  final, so no key waits for it, rows repainted meanwhile (the cursor
  line, a blame text) go on sliding as they are, and another move or a
  whole repaint ends it at once. Not while a window is pixel-scrolled,
  not in floats, not with reduced motion; 60 ms is over before the next
  key at any typing speed.
- What sits on a window's text rides it (`riders.ts`): inline images and
  cards and popups (the page's DOM) are drawn where their line
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
  DevHub's terminals; the base key from `code` through the layout,
  `surfaces/baseKeys.ts`, so a dead key is `<M-e>` and JIS Option+¥
  `<M-Bslash>`), `<D-…>` for Cmd, named keys, `<lt>` and friends.
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
- Resize: its element's size over the cell size, `nvim_ui_try_resize`.
- Focus: `nvim_ui_set_focus` (FocusGained/FocusLost), told once per
  change. The editor has the keyboard when its textarea is focused _and_
  its terminal's page has the keys (`document.hasFocus()`, followed on the
  window's `focus`/`blur`): a page keeps its focused element while the
  Sidebar, an Agent or another view has them. Within the page, the terminal
  or another Neovim having the keys is the textarea not focused. A Neovim
  focuses itself only while it has them (`NeovimEditor.setKeys`). Without it the block cursor is
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
- Where the command line is (`cmdlinePlace`; mock 2, the person's pick):
  at the bottom, in one bordered box for `:`, `/`, `?`, `=`, an `input()`
  and a prompt alike. The bottom is Neovim's promise that what is typed,
  the answer to it, the mode and the ruler are in one place; one box for
  all keeps that place and shape whatever is typed, and only the mark
  before the text (`:`, `/`) differs: plain text, the box's ink a little
  dimmed, no chip around it, at the inset of the rest of the box. The box is a floating surface
  ("Floating surfaces"): `NormalFloat`'s ground and ink, `FloatBorder`'s
  1px line and the floats' corner — the material of the completion menu
  that opens over it — enough to tell typed text from the windows' text
  while it is up, and has no arrival.
  - With `cmdheight` > 0 it is in those rows, centred: the rows the person
    kept are where they read what they type. Content taller than them (a
    prompt's question, a wrapped line, `cmdline_block`) grows the box
    upward over the windows, as Neovim's message area rises; what does
    not fit the editor is cut from the top, the line being typed stays.
  - With `cmdheight=0` there are no rows: the box sits on the lowest
    window's status line, over the window's last lines, with a shadow
    (it stands on the text).
  - A search's count is at the box's right edge as the pattern is typed
    (`searchcount()` on `CmdlineChanged`; Neovim says `search_count` only
    once it is entered) and stays there with the search echoed after
    Enter, in the same place without the box (with `cmdheight=0`, in the
    box for 4 s: no row keeps it).
  - While nothing is typed, the rows `cmdheight` keeps are Neovim's own
    line, quietly: the mode (`-- INSERT --`, recording) or the search
    echo at the left, `showcmd` and the ruler dimmer at the right. With
    `cmdheight=0` they are not drawn, as Neovim draws none there.
  - `q:` (the command-line window) is the box grown upward: Lua says which
    window it is (`CmdwinEnter`), and its edges and hairline go round that
    Neovim window, a header naming it where the status line above was
    (`Enter` runs, `Ctrl-C` closes), its own status line covered. Where
    it is, its cursor and its clicks stay Neovim's: only a frame is added.
- The text sits on whole cells in the grid's font, two cells in, and
  Neovim is told where: `g:ui_cmdline_pos` (`[row, col]`, the convention
  noice.nvim started), which blink.cmp's `:` completion menu reads. The
  row is the one the box starts in, so blink's menu, which goes on the
  rows before it, ends at the box's top; the column is `firstc`'s, a cell
  before the text, so a candidate sits over the word it completes.
- Floats are kept on the screen as Neovim's own compositor keeps them: one
  that would run past the right or bottom edge is moved in.

### Floating surfaces

A float someone else opens (the snacks picker, blink's menu, which-key,
lazy's window, any plugin's `nvim_open_win`: everything drawn from
Neovim's grids) is shown as Neovim sends it, for compatibility: DevHub adds
a border and fuses panels, and nothing else — it neither reads a float's
content into richer UI nor hooks the float API to reinterpret it. Where a
richer surface is wanted, a native DevHub component replaces a Neovim
feature piece by piece, through that feature's own handler (devhub.nvim's
`hook_floats` makes LSP hover, signature help and diagnostic floats
`gui.popup`s; the quick pick takes `vim.ui.select`; notifications, the
messages pager, the command line's box, the completion menu), rather than
dressing Neovim's cells. The person: 「既存のfloating windowについては
borderと結合だけ注意して、中身はそのまま表示する。それ以外のリッチなUIが
必要なところは、devhub側のネイティブGUIで置き換えていく。」

A Neovim float:

- one rounded border whatever its border type: a 1px line, the floats'
  corner (`--float-radius`, 4px) and shadow (`--float-shadow-filter`);
- half a cell of padding between the line and the text, in the border's
  ground (without a border, the float's own, outside its cells);
- its content as-is: monospace cells, a title or footer the cells Neovim
  put in the border, on the line; no header band, no UI-font title, no
  rounded selection band, nothing grown into a blank border;
- the line's colour is the border's `FloatBorder` ink where it names one,
  else the float's ground 18 % toward its ink (a config that links
  `FloatBorder` to `NormalFloat`, so `'solid'` draws nothing, names none);
- floats edge to edge are one panel ("The page", above): one shadow, the
  outer corners rounded, one line where two members with borders meet.

DevHub's own floating surfaces — `gui.popup`, the completion menu, the
command line's box and its window, the messages pager, the quick pick, and
tmux's `display-popup`, `display-menu`, `choose-tree` and the prompt's
completion — share one set of tokens (`shell/styles/tokens.css`, "Floating
surfaces", 「接地」, grounded):

| token                                     | value                                                     | why                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--float-radius`                          | 4px                                                       | a quarter of a row: it ends inside the padding, so a corner never reaches text and reads as a part's corner. 6 and 8 px corners with no padding put text into the curve, a blob. |
| `--float-band-inset`                      | 2px                                                       | a selected row's band, inset 2 and rounded 2: concentric with the 4 px corner.                                                                                                   |
| `--float-pad-block`, inline a cell        | 4px                                                       | the padding inside a surface's line, so the text never touches the edge.                                                                                                         |
| `--float-shadow`, `--float-shadow-filter` | `0 1px 2px` + `0 2px 6px`, 10 %/6 % Light, 40 %/24 % Dark | close: gone within a third of a row, so a panel is put down on the page, not lifted off it; the same at every size; stronger in Dark, where a light one cannot be seen.          |
| `--float-arrive`                          | a fade, `--motion-fast`                                   | what comes and goes with each key does not travel (the completion menu's 4 px slide is gone).                                                                                    |

Their colours are the theme's own groups, never DevHub's chrome:
`--float-ground` and `--float-ink` are `NormalFloat`'s, `--float-line` is
`FloatBorder`'s ink, a 1px CSS border on whole device pixels, and
`--float-band` is `StatusLine`'s ground (`floatLook`). A `FloatBorder` that
is only the float's own ink or ground names no line; the line is then the
ground 18 % toward the ink. With no `StatusLine` the band is half way
between the editor's ground and the float's. The editor sets them on
`.nvim-host` for what DevHub draws over it. A tmux surface takes them from
the terminal's colours (`popup.css`): its ground is the panes' 7 % toward
the ink (in DevHub's themes that is `NormalFloat`), so a popup is never
the pane it stands on (the painter grounds the popup's grid in the same
mix, `popupGround`); its line 18 % on from there; its band half way.

A DevHub surface's title is a band: a row in the band's ground with a 1px
line under it, one row tall, the cell's height (the person: 「一行と同じくらい
の高さあったほうがバランス取れるやろ」) — a tmux popup's title (its border
row), a menu's title, the chooser's filter and the quick pick's header. The
chooser's preview is a picture of the pane, in the pane's ground. Inline
cards (review threads) ride a line rather than float, and keep their card.

### Messages

Neovim's messages (`ext_messages`), the person's pick ("C" of three mocks):
merged into the notifications' corner, with the prompts and the long output
where they are read (`shell/neovim/messages.ts` routes, `redraw.ts` keeps
the prompt and the band, `main/editor/neovimMessages.ts` is the Lua).

- **Ordinary messages** — `:echo`, `:echomsg`, errors and `:echoerr`,
  warnings (`wmsg`), undo's and a write's reports, a plugin's `print` — are
  notifications under "Neovim", in the same quiet lines as `gui.notify`
  (the UI face, the tone by level: `emsg`, `echoerr`, `lua_error`,
  `rpc_error`, `shell_err` or an `ErrorMsg` highlight is an error, `wmsg`
  or `WarningMsg` a warning). One place for what the editor says, and the
  command line's rows stay for typing. A message of more than four lines
  nobody typed for (a plugin's trace) shows its first four and how many
  more, `:messages` having all of it.
- **Repeats collapse** — undo's and redo's reports, a quickfix step, a
  completion's count and `wildlist` say where something is now, so each
  replaces the one before: one line that changes, not a column of them.
  Any message said again while it shows is that line again, its fade
  started over; a progress message (`:w`'s) is updated under its id.
- **Prompts** — on 0.12 every question comes as a `confirm` message and a
  prompt on the command line (`confirm()`, `inputlist()`, `z=`, the swap
  file's question with its E325 heading said just before it), or as the
  prompt alone (`:s///c`). The question is shown in the command line's box
  over its prompt, the box grown upward to hold it (cut from the top if
  the editor is shorter), and answered with the keys as Neovim reads them.
  It goes when the prompt's command line does, answered or abandoned: a
  prompt can be neither lost (it is where the person types) nor stuck (the
  keys are Neovim's, not a dialog's), and a notification never covers it
  (the corner rises above the box).
- **Long output** — what a command was asked to print (`list_cmd`: `:ls`,
  `:map`, `:set all`; `:!cmd`'s output; a typed command's output of three
  lines or more; `:messages` and `g<`) opens in the pager: a Neovim buffer
  (`filetype=devhub_pager`) in a float across the editor, its bottom on
  the lowest status line, at most 60 % of the editor's height. In a buffer
  it is moved through, searched and yanked with the person's own keys
  (`j`/`k`, `/`, `y`); `q`, `<Esc>` and `<CR>` close it (`<CR>` as it
  dismissed Neovim's hit-enter prompt), leaving its window closes it, and
  `<Tab>` goes between Messages (`:messages`, with Neovim's highlights) and
  Notifications (`gui.history()`). Its blank border carries a header (the
  command, or the two tabs, and how many lines) and a footer of keys,
  which DevHub's frame draws as rows inside it. A one-line answer
  (`:pwd`, `:set ts?`) is a notification instead: not worth a window.
- **`cmdheight`** — Neovim sets it to 0 when a UI takes `ext_messages`
  (and to 1 when it goes). The rows a config keeps are the person's, so
  the value is read just before that attach and put back; one the person
  sets while DevHub is attached is kept for the next attach. A pane's
  `--embed` Neovim reads its config only after its first attach: there it
  is put back in the same request as the attach, before the config runs,
  and what the config leaves is read once Neovim has started (no
  `OptionSet` fires while it starts).
- `ui2` stays off: it takes `ext_cmdline` and the messages itself and the
  command line would no longer be DevHub's.

### Webviews: web content lives inside Neovim windows

The rule: Neovim owns layout, state and input; every GUI element is attached
to a Neovim object and follows it.

```lua
local gui = require('devhub_gui')
local w = gui.webview{ title = 'Outline', html = '<button>…</button>', win = 'vsplit' }
--                 or url = 'https://…'; win = 'vsplit' | 'split' | 'float' | 'tab' | 'current'
--                 keyboard = 'neovim' (html's default) | 'content' (url's)
w:on_message(function(msg) … end)       -- the page's devhub.send(msg)
w:send({ kind = 'outline', … })          -- the page's devhub.onMessage(fn)
w:close()
```

In a float with a border (`win = 'float'`), the content goes inside
the border, whose cells Neovim draws. A GUI window is a scratch buffer (`buftype=nofile`, `filetype=devhub_gui`,
its id in `b:devhub_gui_id`) shown in an ordinary window or float; the page
paints its web content (a sandboxed iframe) exactly over that window's grid.
So `:vsplit`, `<C-w>hjkl`, `<C-w>=`, `:close`, `:q`, `:only` and tab pages
are Neovim's own, and the content follows. A click into it makes it Neovim's
current window. Its content is kept in the Lua module, so it outlives a
DevHub restart.

**Its keys are Neovim's.** Neovim is the modal engine, and a page must not
be an island the keys fall into: while a GUI window is current and no field
in it has the keys, they are Neovim's, as in normal mode — `:`, `<C-w>…`,
`<Leader>…`, `/`, counts and the person's maps all work there
(`shell/neovim/guiFrame.ts`, `SETUP_LUA`'s keyboard part). Each choice and
its reason:

- _The buffer's lines are the page's focusable elements_ (links, buttons,
  fields, `[tabindex]`; enabled and visible, in document order), one per
  line, its label the element's `aria-label`, `<label>`, placeholder or
  text; _the cursor line is the focused one_. This is `gui.view`'s model,
  and for the same reason: `j`/`k`, `5j`, `gg`/`G`, `/Filter`, marks and
  macros are Neovim's own, so they behave as everywhere else and nothing is
  reimplemented. Mapping `j`/`k`/`<Tab>` to "next element" instead would
  break counts and search and shadow the person's maps. The page reports its
  list again whenever its DOM changes (a `MutationObserver`, only when the
  list differs) and rings the element Lua names (`data-devhub-focus`, an
  outline in `Cursor`'s colour while the window is current, as a view rings
  its item), scrolled into sight. The page never moves its DOM focus for
  this, so the keys stay Neovim's.
- _`<CR>` activates_ the element (a click), or enters it if it is a field.
  `<Space>` is not mapped: it is a common `<Leader>`, the person's config
  included.
- _A field is insert mode._ `i`/`a` enter the focused field with its caret
  where it was, `I` at its start, `A` at its end; a click on a field enters
  it too. Neovim really goes to insert mode — so a status line says INSERT
  and `mode()` is `i` — and the keys go to the field. The buffer is
  modifiable only meanwhile (Neovim enters no insert mode in a buffer that
  is not; `i` on a button does nothing, and `o`, `cc` and the like answer
  E21), with no undo, and a key that still reaches Neovim is undone. `<Esc>`,
  `<C-[>` and `<C-c>` in a field are sent as Neovim's `<Esc>`: leaving insert
  mode, by any means (`ModeChanged`, since `<C-c>` runs no `InsertLeave`;
  a `stopinsert`; another window becoming current), blurs the field and
  gives the keys back. `<Tab>` in a field moves the page's focus as the web
  does; the cursor follows, and on an element that is not a field Neovim is
  in normal mode again.
- _A key the frame gets while no field has it_ (it took the focus a moment
  with a click) is sent on to Neovim as the editor would send it, and the
  editor takes the keyboard back: none is lost.
- _A page can declare its own keys_: `devhub.keys({ X: (el) => … })` maps
  them on the window's buffer (Neovim owns them; `:map` lists them), and the
  page's function gets the focused element. A plugin's Lua maps keys on
  `w.buf` as on any buffer.
- _`keyboard = 'content'`_ gives the keys to the page whenever its window is
  current, as a web app that reads raw keys needs; `<C-w>` gives them back to
  Neovim, which reads the rest of the window command. It is a `url` page's
  default and its only choice: a page DevHub did not write has no bridge to
  say what it holds, so `keyboard = 'neovim'` with `url` is an error. Such a
  page taking the focus with a click makes its window current.

`:DevhubGuiDemo` opens an Outline beside the current window: its buttons jump
that window to a function, or run `gg`, `G`, `:write` in it, and its Filter
field narrows them (`i` to type, `<Esc>` to leave, `X` — the page's own key —
to clear it).

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
  the way fidget does. Neovim's own messages join them under
  "Neovim" (Messages, below). Each choice and its reason (`DecorationViews.tsx`,
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
  - _History._ What fades can be read again: `gui.history()` answers the
    notifications shown, oldest first (`time`, `group`, `title`, `msg`,
    `level`, `key`), at most 200, kept across attaches;
    `gui.clear_history()` empties it. Work in progress is kept only once
    done (its ticks are not news), and a `key` shown again replaces its
    entry. `:DevhubNotifications` (devhub.nvim: `:Notifications`,
    `gui.notifications()`) reads it in the pager (Messages, below): time
    dim, source, the message in the toast's tones, newest last; `<Tab>`
    goes to Neovim's `:messages`. Not mixed into `:messages`: a plugin's
    notifications there would bury undo and errors, and putting them there
    (`nvim_echo`) would draw them again as Neovim messages.
- **image** — an extmark's `virt_lines` reserve `height_rows` blank rows
  under the line, so Neovim lays them out (the cursor steps over them,
  `:vsplit` shows them twice) and DevHub paints the image there. A path is
  read on Neovim's machine and sent as a `data:` URL (an SSH host's file
  works); an `https:` URL is passed as it is. Where
  it is — the row under the line's last screen row, after the rows of any
  `virt_lines` Neovim stacks there first (another image, a card, a
  plugin's), the text column, from the window's top — is worked out again
  (`screenpos`, `getwininfo`) on
  every `WinScrolled`, `WinResized`, `CursorMoved`, `TextChanged`, window
  open/close and tab change, for every window of the tab page showing the
  buffer; a closed fold hides it, a window's bottom clips it.
  `:DevhubImageDemo [path]` opens a markdown buffer with one (with no path,
  a small generated PNG).

### Components, views, inline cards and popups

The rule again, for what a plugin wants to show rather than a page: Neovim
owns the state, the layout and the keys; DevHub only paints, and what it
paints is **data**. A config describes content as declarative components
(`shell/neovim/components.ts`: types, the checks a payload passes, and the
layout decisions, pure and unit-tested; `ComponentView.tsx` draws them):
`stack`/`hstack` (gap, padding, alignment, a raised `card`, an `accent`
ring (its edge in the accent's colour; no side stripe), a ground, an indent), `text` runs, `markdown` (GFM, fenced code
coloured by the conversation view's highlighter, links opened in the
browser), `badge`, `kbd`, `button`, a tri-state `checkbox`, `progress`, a
Nerd Font `icon`, an `avatar`, `spacer`/`divider`, `sparkline`, a small line
`chart` and an `image`. Every colour is a highlight group's name (or a tone
that names one), resolved by Neovim (`nvim_get_hl`) and sent with the tree,
so a view wears the colorscheme and follows `:colorscheme`. Text is in
DevHub's own (proportional) type, `mono` in the grid's face. There is no HTML
and no script in it: a node with `on_click` gets an action number, and a
click sends that number back to Neovim, where the function runs. A node of
the wrong shape is dropped. `gui.webview`'s HTML stays the escape hatch.

The Lua is `main/editor/neovimGuiLayers.ts` (`LAYERS_LUA`), run into
`devhub_gui` at every attach after `SETUP_LUA`; devhub.nvim's `gui.ui` builds
and checks the trees and its `gui.view`/`gui.inline`/`gui.popup` forward
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
local pop = gui.popup{ anchor = 'cursor', component = ui.md(markdown), max_width = 80,
  keys = { ['<CR>'] = function(p) end } }                    -- :focus(), :scroll('half'), :close()
local list = gui.view{ buf = lbuf, win = lwin, keys = { { '↩', 'open' } },            -- a framed view: a picker
  items = function(lnum, line) return ui.text(line) end,                             -- or { node, heading }
  on_click = function(lnum, clicks) end, on_scroll = function(rows) end, on_rows = function(rows) end,
  frame = { win = float, query = { win = qwin, placeholder = 'Search' },
    preview = { win = pwin, title = ui.text('src › a.ts') }, title = ui.badge('Files'), status = ui.text('3 / 9') } }
                                                          -- :frame{ status = … }, :redraw(), :close()
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
- **A framed view** (`gui.view{ frame = … }`) — the same view drawn in a
  frame over a float instead of over its window: a picker's frontend,
  whoever's picker it is. The plugin lays out Neovim windows and DevHub
  draws each part where its window stands (`FramedView.tsx`'s
  `frameParts`): the view's items in the cells of the window showing its
  buffer (hidden: `hide = true`), whose cursor line is the focus; a
  header on the **query** window's rows — `title`, the query window's first
  line as a field with the caret at its cursor while it is in Insert mode,
  `status`; the **preview**, a window drawn as cells, with its title on the
  row above it; and `keys` as the hint row, on the frame's last row. Items
  are a line and a third tall; `{ node, heading }` items put a heading
  above an item that is not one; a click is `on_click(lnum, clicks)` and
  leaves the keys where they are, the wheel `on_scroll(rows)`, and
  `on_rows(rows)` says how many items fit (the plugin's page size). Every
  key is still a buffer-local map in the query or the list. A hidden float
  is never drawn, so Lua works its place out from its config. The frame's
  windows are claimed for the page (`claimFloats`): the painter draws
  their cells bare, with none of a float's frame, padding or shadow, and
  the frame draws its own line and shadow round the frame float (a
  `shadow` part under its grid, not cut by it), so the preview's cells
  never cover the title above them or the hint row. snacks is
  drawn this way by
  [snacks-ui.devhub](https://github.com/statiolake/snacks-ui.devhub),
  outside devhub.nvim (`native-picker.md`).
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
  (`hide`), which its caller may close (the popup closes with it)
  and which closes with the popup. `K K` focuses the popup instead of
  opening a second. A float's `border` and `title` give way to DevHub's
  frame; `max_width`/`max_height` are kept. Outside DevHub or on
  any error, Neovim's own float; `vim.g.devhub_rich_floats = false` keeps
  Neovim's always.

In plain Neovim (or a terminal), devhub.nvim's calls do nothing: a view is
its buffer's text, a card reserves nothing.

**Plugins are the users.** These calls are a public API for any plugin:
devhub.nvim ships none of its own on top of them, and DevHub knows no
plugin that uses them. A plugin draws through `require('devhub').gui` when
`gui.available()` and its own Neovim way otherwise (a view is its text, a
card's content virt_lines), so it works in a terminal too. A review plugin,
for instance, makes each thread a `gui.inline` card under its lines and its
panel a `gui.view`, with the card's buttons naming the buffer-local keys
that do the same.

### Integrations

- `devhub <file>`, `devhub -g file:line:col`, `devhub --wait` and a
  conversation's file link open in the
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

`nvim [args]` in a DevHub terminal — the Workspace's (its editor area) or an
Agent's; typed, or run by `git commit`, `crontab -e`, `$EDITOR` — is
DevHub's Neovim (Which Neovim) with the person's config, drawn by DevHub's
GUI exactly over that tmux pane, in place of its TUI. The command
blocks like any editor and returns Neovim's exit status (`:cq` fails a
commit). It works the same in a terminal on an SSH host.

**The shim** (`main/editor/terminalNeovimShim.ts`). DevHub writes a POSIX
`sh` script named `nvim` on each machine — `<DevHub's data>/devhub/nvim-bin/`
here, `~/.devhub/terminal/nvim-<tag>/` on a host — and puts its directory in
front of the PATH of every pane it creates (the way a host's `devhub` is). PATH and not `EDITOR`/`VISUAL`: it catches `nvim` typed
at a prompt and run by other programs alike, and a dotfile's
`EDITOR=nvim` still reaches it. The script has DevHub's Neovim's absolute path
written in (`Runtime.neovimProgram`; on a host it is delivered before the
script is written), never looks one up on the PATH, and runs it with the
person's arguments, in the pane, as `nvim --embed --listen <socket> args…`: the pane's environment (`GIT_*`), cwd, exit status
and life are a TUI's; only who draws it changes. `--embed` waits for the UI
before reading the config or a file, so a swap-file question or a config
error is shown, not answered blind. It runs the same Neovim as a TUI,
untouched, outside a DevHub terminal (no `$TMUX_PANE`, a session that is neither a
Workspace's `ws-` nor an Agent terminal's `tm-`), with the editor not
Neovim, inside a DevHub GUI Neovim (`$DEVHUB_NEOVIM_GUI`), with stdin
or stdout not a terminal, for non-editing arguments (`--headless`, `-es`,
`--remote*`, `--version`, `-`…), and when no UI attached within ten seconds
(the terminal is not on screen, DevHub not running while its tmux server
still says the overlay is on, the terminal's page or the socket forward
failing): then the waiting Neovim, which has read no config and opened no
file yet, is killed, one dim line in the pane says DevHub did not draw it
(it stays in the scrollback; `DEVHUB_NVIM_DEBUG=1` says every other reason
too), and a fresh TUI runs with the same arguments, cwd and environment —
plain `nvim`, its status the command's. Not a TUI attached to the waiting
one (`--remote-ui`): there is no state to keep, and a remote UI's server
has the FIFO for a stdin, so `:!` and anything else Neovim runs on the tty
would not have it.

**How DevHub learns of it: tmux, not a socket of its own.** The script names
its socket in a pane option of DevHub's own tmux server (`@devhub-nvim`) and
waits for `@devhub-nvim-ui = 1`, which DevHub sets once its UI is attached.
That channel is the same here and on a host and needs no Node, no `devhub`
command and no forwarded control socket over there; the socket itself is
forwarded like the managed Neovim's (`ssh -O forward`). The `devhub-nvim`
window's pane names its Neovim's socket in the same option, which is all it
takes for it to be drawn the same way. The server option
`@devhub-nvim-overlay` says the editor is Neovim, so switching to VS Code
reaches panes that already have the shim. Once it is to draw the Neovim the
script runs the rest of itself under DevHub's Neovim as `nvim -l`
(`NVIM_LAUNCH_LUA`), which waits on it and exits with its status: the pane's
foreground process is then `nvim`, not `sh`, so tmux names the window after
it (`pane_current_command` is the job's leader: `/proc/<pid>/cmdline` on
Linux, `p_comm` on macOS; a window read `sh:demo` before). The launcher
ignores Ctrl-C and Ctrl-\ as the script does, and once the script has run
the TUI instead it stops itself when the TUI suspends, so `:suspend` and `fg`
work. Every pane reading DevHub makes says `nvim` for a pane with
`@devhub-nvim` as well, so closing the terminal still asks first.

**Where the overlay goes** (`main/editor/terminalNeovims.ts`,
`shell/pane/PaneNeovims.tsx`). In the terminal's own page, in its pane. Main
says each terminal's page which of its panes have a Neovim, whether tmux
shows each, and which has the keys (`PaneBridge.onTerminalNeovims`); the
page mounts a `NeovimSurface` for each, in an element of its own that the
terminal surface places. In control mode (below) that element is the pane's
content, and moves with it; one main says is gone stays as its pane's last
picture until its pane's close has moved (`docs/pane-motion.md`, "A closing
pane's Neovim leaves as its last picture"). Without control mode, while a terminal is on
screen — a Workspace's in the editor area (`pane.html#ws:<id>`, its `ws-`
session), an Agent's beside it (`tm-`), both at once in a split — its
session is read every 150 ms (400 ms on a host): each pane's cells, which
window and pane are active, zoom, modes, the socket option, and DevHub's
client's size, key table, prefix and status line. tmux pushes none of a
window switch, a zoom, `swap-pane` or a resize to anyone but the client, and
one `list-panes` and one `list-clients` read all of it. Main says the pane's
cells and the client's size, and the page puts the element over those cells
of xterm's screen (`shell/terminal/PolledNeovims.tsx`). It is hidden while
tmux does not show the pane: another window, a zoomed sibling, copy mode or a
chooser. In control mode what DevHub draws over the panes (a popup, a
prompt, a menu, the chooser) is over the Neovim by the panes' stacking
table, and the Neovim stays shown under it (`docs/terminal-mode.md`, "Over a
Neovim"). Copy mode hides only the Neovim of the pane in it. A terminal not
on screen is not read; its Neovims stay mounted in its page, hidden.

**Its size is its pane's.** The Neovim asks for the grid its element holds
(`nvim_ui_try_resize`), and the element is the pane's cells. Hidden, it stays
at the pane's last size, never `display: none`, since tmux keeps a hidden
pane's size. An element a pixel short of its pane's cells — over xterm.js
the edges are put on whole pixels, and a Retina cell is 16.5 px — still holds
them (`gridSize.ts`). A tmux layout that resizes the pane asks the Neovim for
its new grid before the pane moves, and the move waits for it
(`docs/pane-motion.md`). Neovim draws every UI at the smallest one's size, so
an overlay that goes lets its UI go (`TerminalNeovimsOptions.gone`,
`NeovimEditors.letGoOf`), and so does a page that goes (its terminal closed).
A UI left behind held the Neovim at its last size, which no pane growing
could undo. A page that starts speaking for its terminal in control mode
keeps the overlays the last reading of tmux found, rather than ending and
making them again.

In tmux control mode (`[terminal] tmux_control_mode`, `docs/terminal-mode.md`)
nothing is polled: the terminal's page draws each pane at the rectangle tmux's
layout gives it, and the Neovim in a pane is that pane's content
(`placeNeovims`), moved by the same transforms as the pane on a split, a
close, a zoom or a window switch (`docs/pane-motion.md`). What the page says
is what each pane is (`PaneBridge.reportTerminalPanes`: the shown window's
panes, the active one, every pane's mode and `@devhub-nvim`, the client and
its prefixes, and whether something it draws over the panes has the keys). The pty host's control client hears a
mode change from tmux at once (`%pane-mode-changed`) and `@devhub-nvim`
through a subscription (`refresh-client -B`, which tmux checks once a
second); DevHub's `nvim` also writes an OSC tmux does not know
(`NVIM_NAMED_OSC`) into its pane after naming its socket, which tmux drops
and a control client sees in the pane's bytes, so the pane is read at once.
The page's sockets are a hint: each change of them is one reading of tmux
by main, and only a socket that reading confirms is attached to.
Each Neovim is its own: a `nvim` run in a pane is never the `devhub-nvim`
one and never reused — `devhub <file>`, a conversation's file link and Send
to Agent go to the Workspace's `devhub-nvim` window, and a `git commit`
waiting on a terminal's Neovim gets no other file.

**The keyboard.** The overlay has the keys whenever its terminal would and
its pane is tmux's active pane, shown. DevHub's chords are caught first, as on
every page. The terminal and its Neovims are one page, so the keys reach it
whichever has them. Main keeps whose they are, reads each key in the page's
`before-input-event`, and pushes the page which Neovim has them
(`TerminalNeovimsWire.keys`). The page moves its focus to that Neovim's
input, or to the terminal's. A key main takes on the way in — one that gives
a Neovim the keys, or tmux's prefix typed in one — is typed by the page where
it was meant (`onTerminalNeovimKey`, `NeovimEditor.typeKey`, the surface's
`typeKey`). A press reports where the person put the keys
(`reportNeovimPointer`). On that page Cmd+A/C/X/Z are Neovim's while a
Neovim has the keys (`ChordHost.neovimHasKeys`). The tmux prefix typed in it is tmux's: DevHub puts its client in
the prefix table (`switch-client -T prefix`) and the terminal takes the next
key; once that binding ran (a zoom, a pane switch, a window switch), the keys
come back if the overlaid pane is still the active one. In control mode the
prefix is typed into the terminal surface as the keystroke it was, since that
page's control client keeps its own place in tmux's key tables
(`keyGuard.ts`). A binding that opens
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
SSH host, and nothing comes twice: keys typed in the Neovim go over RPC, and
a key the terminal would hand to the pane is taken from it. When
the Neovim exits the shim ends the reader and gives the tty and tmux's modes
back before it exits with the Neovim's status.

Limits: DevHub's terminals only (an Agent's own pane, `ag-`, gets the TUI);
without tmux control mode nothing drawn by tmux over a pane
(`display-popup`, `display-menu`) shows over a Neovim, and nothing moves; a binding of the person's own that opens a prompt is not
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

**`:restart`.** `:restart` starts a new server with the old
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
  between. The Neovim, its pane, its place and the keys are not touched;
  main hears nothing (no `ended`). The old server's GUI windows
  are closed.
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
- _DevHub's own windows_ (`neovimSession.ts`): `:restart` writes a
  session with the person's 'sessionoptions'. With `blank` in it, a GUI
  window (`gui.webview`, `devhub://<title>/<id>`) or the pager was saved as
  an empty window: the session came back with a dead Outline in it,
  squeezed to a column or three, and current when the cursor had been in
  it. After any session is written (`SessionWritePost`) DevHub appends what
  to do once it is sourced: close the windows that were DevHub's, their
  room to the windows beside them (not evened out by 'equalalways'), and
  make current the window edited before (`wincmd p`) if the current one
  was DevHub's. At every attach a `devhub://` window with no GUI window
  behind it (a session written before) is closed the same way.
- _The sizes_: the new server sources the session once a UI is attached
  (it is now attached to once, at its size, as any first UI; it used to be
  a priming attach at half the size), so the sizes saved
  before that attach were of the server's one first window, and put back
  after it they gave that window every column but one (a two-window
  session came back 132 and 1 wide). An attach now puts back a tab's sizes
  only over the windows it saved. The session DevHub appended to also
  carries each window's size and the screen's; once it has loaded, at the
  real attach, back at that screen size, every window is put back at its
  size exactly (the windows that took a closed GUI window's room with that
  room); at any other size the sizes it loaded at are scaled. A Neovim
  still starting when DevHub attaches (`nvim -o a b`) has its windows'
  sizes scaled the same way from `VimEnter`. Scaling counts a window's
  status line or separator as a cell that does not grow. `cmdheight` stays
  the person's through all of it (`_keep_cmdheight`).
- A `devhub-nvim` Neovim that restarted is adopted again by its socket at
  the next open, as after a DevHub restart (its `$TMUX_PANE` is the
  keeper's, inherited).
- Checked on 0.12.6 with the dotfiles' config: in a
  pane (session and splits back, the pane still the shim's), in the
  `devhub-nvim` window (the next `devhub -g` opens in the restarted one),
  and in `git commit`'s editor (`:restart`, then `:wq` commits). Not
  checked over SSH.

## What works

With DevHub's own Neovim (0.12.6, bundled), in a DevHub run under Xvfb on
Linux with the dotfiles' config and settings and the machine's own Neovim
0.9.5 first on the PATH: `nvim` typed in a Workspace's pane runs the
bundled one (`:version` 0.12.6, `$VIMRUNTIME` and `v:progpath` the
bundle's) drawn over the pane; lazy.nvim installed every plugin, blink.cmp
fetched its prebuilt library and a plugin's build step (review-relay's Go
build) ran; the bundled parsers, and all 311 of neovim-treesitter-binaries'
Linux parsers, load; `devhub -g` opened in the `devhub-nvim` window and
`:restart` there was followed (a new bundled server, the keeper's pane
kept, the overlay drawn again). Against an sshd on localhost (glibc 2.39,
Neovim 0.9.5 on its PATH): opening the Workspace delivered
`~/.devhub-server/nvim/0.12.6`, and `nvim` typed in its pane ran that one,
drawn as an overlay, the config's plugins installed on the host.
Earlier versions' verification below stands for what did not change.

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

Drawn in the terminal's page (DevHub run under Xvfb at 2×, the dotfiles'
settings with control mode, tmux.conf and Neovim config). These were checked:

- the `devhub-nvim` window's Neovim and a `nvim` typed in a pane, side by
  side in one tmux window, each with its own UI, the keys moving between
  them with tmux's pane moves;
- typing; the prefix (`C-q z`) from a Neovim and the keys coming back;
- the command line and its completion menu;
- a snacks picker (framed) and `vim.ui.select` through it;
- fidget's and `vim.notify`'s notifications;
- `:DevhubGuiDemo`'s GUI window;
- `:restart`, followed with the pane, the place and the keys kept; with
  `:DevhubGuiDemo`'s Outline open and current beside a split: no Outline
  after it, the window edited before current, every size as it was, the
  Outline's columns to the window beside it, and the same after a second
  `:restart` (`neovimSession.real.test.ts` too);
- `cmdheight` (2) after the first attach (`nvim -o`: 19 and 18 rows), a
  DevHub restart, `:restart`, a tmux split below the pane and its close,
  and a zoom and unzoom: it stayed 2 each time, the windows' rows given and
  taken by the windows (a pane made shorter takes them from the last
  window, as Neovim does, and growing back gives them to it);
- a window resize;
- a DevHub restart (both Neovims attached again);
- the Neovim host killed (both reconnect);
- one pane's Neovim killed (its pane back to the shell, the rest untouched);
- without control mode, the Neovim placed over its pane's cells of the
  xterm.js screen.

Not checked again: an IME's preedit (Xvfb has none; its code is unchanged,
in the same textarea) and SSH hosts.

## Limitations

- Dev containers: refused with a sentence.
- DevHub's Neovim only: a host it cannot run on (musl, glibc before 2.34,
  not Linux on x86_64 or arm64) has no Neovim editor, and its panes' `nvim`
  is the host's own TUI.
- 0.12's `ui2` takes the command line and the messages from DevHub:
  leave it off in DevHub (Messages).
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
  only `~` and a few chrome groups use them).
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
(devhub.nvim) forwards `webview` (its handle's `send`, `on_message`,
`close`), `notify`,
`image`, `view`, `inline` and `popup` to the `devhub_gui`
DevHub injects — one implementation, owned by the end that speaks the RPC —
queues calls made before the attach until `User DevhubGui`, and does nothing
outside DevHub (`notify` falls back to `vim.notify`). Still to come:
diagnostics and virtual text drawn from extmarks (`ext_hlstate` +
`win_extmark`), a component for a diff hunk, and more adapters
(incremental diff review, pahcer) on the same layers.

**The completion menu** (round 7, the person's pick). Both menus — DevHub's
own (`ext_popupmenu`: a native completion, `<C-x><C-o>`) and a plugin's
float (blink.cmp, nvim-cmp) — say the same things the same way. DevHub's own
is `shell/completion/CompletionMenu.tsx`, shared with the tmux prompt of a
control-mode terminal (`docs/terminal-mode.md`), so completion looks one way
across DevHub:

- _Candidates_ stay in the editor's face, on the editor's line: a word is
  the text that will land in the buffer, so it looks as it will there. The
  menu sits three cells left of its anchor (padding, mark, gap), so a
  candidate lies over the word it completes.
- _Kinds_ are vector marks (`kinds.ts`), not Nerd Font glyphs or letters:
  eight shapes for LSP's twenty-five kinds — `∧` a callable (an action),
  `●` a value, `○` a variable (a place a value goes), `⊔` a field (a slot
  of a structure: a tray, open at the top, since a hollow square is what
  a missing glyph looks like), `■` a type (the structure), `–` a keyword, `◇` a
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
- _Shape._ The menu is a floating surface ("Floating surfaces"): the
  floats' corner (4 px), line and shadow. Its selection is a band rounded
  concentrically: inset half the radius (2 px) and rounded by the rest
  (2 px), the menu's own
  shape smaller, as Zed's; VS Code's square band in a rounded widget is two
  shapes. A plugin's menu drawn as a Neovim float (blink's) is its cells
  as sent, its selected row square ("Floating surfaces"). Colours are
  `Pmenu`/`PmenuSel`.

**Review threads** keep their card (a raised, rounded card with clear
buttons — the person preferred it to a flat band with quiet key hints).
Round 7 took away the coloured, thicker stripe on its left: the state is
the label in its header (and in the panel's list), so the stripe said it
twice and broke the card's one border. No DevHub surface draws one; a
plugin's own `ui.card{ accent = … }` rings the card in its colour instead.

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
  no seam between cells, `~` past the end left out, box drawing and Powerline glyphs as crisp geometry, a float's
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

1. _Window separators_ (`│` in a whole cell column) — done, as panes
   with a boundary (above): each window's pane takes half the column, a
   hairline is their shared edge, splits meet edge to edge like editor
   groups. Clicks and drags on the column stay Neovim's (the sash).
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
ENTER`) — done (round 9): `ext_messages` on, Neovim 0.12 only, which asks
   every question through the command line and has no hit-enter prompt
   for such a UI. Of three mocks (a panel, a pager, the corner) the person
   picked the corner for ordinary messages, the pager for long output and
   the command line's box for prompts (Messages). `ui2` stays off: it and
   DevHub's `ext_cmdline` exclude each other.
7. _Sign, number and fold columns_ — as Neovim draws them, cells. Rounds
   2–3 drew the fold column's `-`/`+` as chevrons (an open fold's only on
   hover), taken back in round 5 as an invention; round 9 brought them
   back (`⌄`/`›`, mock 3) with a closed fold's line as `›`, its words in
   the UI face, a dim line count and a fading hairline. Taken back again:
   a fold's line is its `foldtext` and `fold:` fill, and the fold column
   its marks, as the person's config has Neovim draw them.
8. ~~_Indent guides_~~ — round 3 redrew any guide plugin's character as
   one light line at the cell's left edge; taken back in round 5. A guide
   is the plugin's own character where its config draws it; box-drawing
   characters are continuous across `linespace` as all box drawing is.
9. ~~_Diagnostic virtual text and inlay hints as pills_~~ — taken back in
   round 5: square, as the highlight says.
10. ~~_Diff filler lines_~~ — a row that was, from some column on, only
    `-` in `DiffDelete`'s ground was drawn as a hatched band of thin
    diagonals. Taken back: a filler row is Neovim's `diff:` character in
    `DiffDelete`, as every diff line is what Neovim says.
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
    socket reached by a relay like the `devhub` command's), ligatures, a
    glyph-atlas (WebGL) painter if large redraws need it, and the
    Sidebar following the current buffer.
