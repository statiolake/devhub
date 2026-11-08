# The editor area: a Workspace's terminal

Every Workspace's editor area is its terminal: its `ws-` tmux session in a
terminal page (`pane.html#ws:<workspace id>`), which is what DevHub lands on
at startup and when a Workspace is opened or selected. Every Neovim in it —
`nvim` typed in a pane, `git commit`'s, and the `devhub-nvim` window files
DevHub opens go to — is DevHub's GUI drawn over its pane; see
[`neovim-editor.md`](neovim-editor.md). There is no separate editor page, no
placeholder and nothing to start or stop: `Cmd+Q E` (`focus_editor`) puts the
keys in the terminal (or the Neovim over its active pane). A session whose
last window closed is made and attached again at once. Neovim's own
`:terminal` is drawn as any other window's grid.

(It used to be a VS Code workbench per Workspace; that went with VS Code,
`docs/without-vscode.md`.)

## The Option key

`terminal.mac_option_is_meta` (`false` | `true` | `"left"`, default `false`)
is what macOS's Option key is in DevHub's own terminals — the Workspace
terminal, pane terminals and Agent panes — and is the Terminal screen's
Keys ▸ Option key popup. It applies at the next key press, no restart.

- `false`: Option types what the keyboard layout puts on it (`≈` for
  Option+X on a US layout; `@`, `{`, `[` on German and the international
  layouts). Alt mappings do not fire: Neovim's `<A-e>` sees `´`, a dead key.
- `true`: Option with a key sends `ESC` and the key (`ESC x`, `ESC X` with
  Shift), which is what Neovim `<A-…>` / `<M-…>` mappings, readline's `M-b`
  and tmux's `M-` bindings read. The characters on Option are gone.
- `"left"`: the left Option is Meta and the right one still composes — iTerm2's
  "Left Option key: Esc+", Ghostty's `macos-option-as-alt = left`.

No key is excepted: under `true` every Option chord is Meta, including the
ones the layout types a character with. On a Japanese (JIS) keyboard `\` is
Option+¥, so under `true` it is `ESC \`; a JIS user who wants Alt mappings
and `\` uses `"left"` and types `\` with the right Option (or keeps `false`).
This is the same answer iTerm2 and Ghostty give.

xterm.js does the encoding (its `macOptionIsMeta`); DevHub decides, per key,
whether that switch is on (`shell/surfaces/optionKey.ts`). The left Option is
followed from its own keydown and keyup, since a letter's keydown does not say
which Option is held; one already held when the terminal took focus counts as
up until it is pressed again. A refused value is `invalid_mac_option_is_meta`.

A Meta key sends only its `ESC` sequence. Option+N, E, U, I and `` ` `` are dead
keys on a US layout, and macOS starts their composition before the page sees
the key, so cancelling the keydown is not enough: the next key would commit
the mark (Option+N then Option+P used to add `˜π` after `ESC n ESC p`). A
composition that starts on a Meta key is therefore kept from xterm and its
text dropped (`shell/surfaces/xtermSession.ts`); one that starts on any other
key — the right Option under `"left"`, every Option under `false`, an IME — is
untouched, so Option+E then e is still `é`.

VS Code's integrated terminal is not covered: it reads
`terminal.integrated.macOptionIsMeta` (a boolean; no left-only choice), and
DevHub writes no terminal settings into the workbench (see
`main/workbenchDefaults.ts`). Nor is the editor: VS Code dispatches `alt+…`
keybindings by key code, so they work with Option on a Mac regardless.

```toml
[terminal]
mac_option_is_meta = "left"   # left Option is Meta (ESC-prefixed); right Option composes
```

## The managed Neovim server

Where files DevHub opens go ([`neovim-editor.md`](neovim-editor.md)): DevHub
keeps **one Neovim per Workspace of its own**, in the Workspace's
`devhub-nvim` tmux window — separate from any Neovim the person starts in a
terminal, and never one of those (a `git commit` waiting on its editor is
never handed another file).

### Where it runs

The first file open for a Workspace opens a **new tmux window** in that
Workspace's `ws-` session (`new-window -d -n devhub-nvim -P -F
'#{pane_id}' -c <root> -- env DEVHUB_NEOVIM_GUI=1 <nvim> --headless
--listen <socket>`), on the Workspace's machine. tmux keeps it alive across
DevHub restarts and SSH reconnects. The pane draws nothing (the Neovim is
headless); DevHub draws it, over that pane, like any Neovim in a terminal.

Then DevHub selects the Workspace (beside the asking Agent, for a conversation
link, exactly as the VS Code routing does), opens the file over RPC, and
shows the window: one tmux queue names the socket on the pane
(`@devhub-nvim`, which is what the overlay reads), `select-window`s it and
`select-pane`s it (`showEditorPaneArgs`). The keyboard goes to the Neovim
drawn there, wherever it was. `:q` ends it and its window closes; the next
open makes it again.

### The socket

On this Mac, `<userData>/devhub/nvim/<digest>.sock`, where the digest is the first twelve
hex digits of the SHA-256 of the Workspace id: one per Workspace, stable across
DevHub restarts, and DevHub's alone (the directory is `0700`). A path that
would exceed the platform's `sun_path` (104 bytes on macOS) falls back to
`$TMPDIR/devhub-nvim-<uid>/`; a fallback that is still too long is a failure
that says so, never a socket that silently fails to bind.

### RPC

A small msgpack-rpc client in main (`main/editor/msgpack.ts`,
`main/editor/neovimRpc.ts`) over the unix socket. Chosen over `nvim --server
<sock> --remote` / `--remote-send`, because:

- `--remote-send` types keys, so what it does depends on the mode the person
  left Neovim in (insert, a pending operator, the command line); RPC calls are
  mode-independent.
- one long-lived connection per server is also the **death detector**: the
  socket closing is Neovim exiting, observed the moment it happens, with no
  polling and no extra process per jump.
- arguments travel as values. A path with spaces, quotes or `|` needs no
  escaping because nothing is parsed as a command line.

The open is one `nvim_exec_lua` call with the path, line and column as
arguments: `:drop` the file (it focuses a window already showing it), falling
back to `:edit`; set the cursor (clamped to the buffer); `zv` to open folds;
`zz`. Before it, `nvim_get_mode` — if Neovim is blocked at a prompt (hit-enter,
`confirm()`), `<Esc>` is sent once so the request is not queued behind it. A
selection with an end puts the cursor at its start.

`devhub --wait` is honoured: the same call registers `BufDelete`,
`BufWipeout`, `BufUnload` and `VimLeavePre` autocommands for that buffer that
delete the wait marker, so `EDITOR="devhub --wait"` works with `git commit`.
Markers are also remembered beside the server and deleted by DevHub when the
server dies without running its autocommands (a `kill -9`).

### Lifecycle

`ManagedNeovims` (`main/editor/managedNeovim.ts`) holds `{ paneId, socket,
client, waitMarkers }` per Workspace. Every jump re-establishes the truth
before using it:

1. **Alive** — the record's connection is open _and_ the pane is still one of
   that Workspace's marked panes on DevHub's tmux server: use it,
   open the file.
2. **Not known, but a server answers on the socket** — DevHub restarted while
   Neovim kept running in tmux (sessions outlive DevHub, so this is the normal
   case after a relaunch). The server is asked for `$TMUX_PANE`, the pane is
   checked against the Workspace's panes, and it is **adopted**. No state file:
   the socket path is deterministic and the pane is the server's own answer.
3. **Dead or stale** — the connection closed, the pane is gone or not this
   Workspace's, or the socket file exists with nothing listening (`ECONNREFUSED`):
   the record is dropped, the stale socket unlinked, outstanding wait markers
   deleted, and a new Neovim is started in a new window.

Starting waits (bounded) for the socket to accept a connection, and gives up
early — with "Neovim exited before it opened its socket" — if the pane has
already gone, which is what a broken config that `:cq`s looks like.

**Closing a Workspace** kills the managed pane and unlinks the socket, in the
close's `editor` step, after its workbench (if it has one) has agreed to
close. Its
unsaved buffers are protected the way any running program in the Workspace's
session is: the close confirmation counts a pane running something other than
the shell as busy work, so the person is asked first. **Quitting DevHub** only
closes the RPC connections; Neovim keeps running in tmux and is adopted on the
next jump.

### The `nvim` binary

The person's `nvim`, looked up on the login PATH DevHub already imported (the
same lookup `runtimes.*` gets, `main/shell/runtimes.ts`), resolved at the first
jump. Missing is a notice that names `nvim` and the directories searched, and
the jump is refused — not a pane that flashes and closes.

## File-open routing

The rule that picks _which Workspace_ is unchanged (`routeOpen`,
`routeAgentOpen`); with `general.editor = "neovim"` the file goes to that
Workspace's `devhub-nvim` window, shown in its terminal
(`AppController.openInEditor`; Scratch is selected first, as a workbench's
start would), and otherwise to its workbench
(`AppController.openRouted`), through the lifecycle (`holdWorkbench`): a frozen
workbench is thawed and a discarded or not yet started one started before the
file reaches it — a file is the one ask besides Enter that starts a workbench;
`devhub <folder>` only selects the Workspace. Scratch is a Workspace like any
other.

| Entrance                                          | Where it opens                                     |
| ------------------------------------------------- | -------------------------------------------------- |
| `devhub <file>` on this Mac                       | the containing Workspace's workbench, or Scratch's |
| `devhub -g <file>:<line>:<col>`                   | caret at the position                              |
| `devhub --wait <file>`                            | `filesToWait`                                      |
| `devhub <folder>`                                 | the Workspace selected, its workbench not started  |
| Conversation file link, Send to Agent's reference | split beside the Agent, workbench in front         |
| Finder Open With / Dock drop / `open -a`          | via `openFromCli`, as above                        |
| `devhub` on an SSH host, an SSH Workspace         | that Workspace's remote workbench                  |
| `devhub` in a dev container                       | the window attached to that container              |
| VS Code's own open (`openInBrowserWindow`)        | DevHub's Workspace / Scratch rule                  |

## Theme

The chrome and the terminal palette come from the colour theme DevHub's own
settings select (`[appearance] theme`, a built-in theme or a `[themes.<name>]`
of the file's; see [themes.md](themes.md)), not from a workbench. That source
never needed a workbench — it paints the window from a cold start and with
every workbench frozen or discarded — and DevHub's own terminals (Agent panes
and their terminals) wear the theme's own colours.

The programs inside the terminal are told the theme too — `DEVHUB_THEME`,
`DEVHUB_FZF_COLORS` and the rest in every new pane's environment, a
`theme.json` that is rewritten on every change, and `User DevhubTheme` in the
managed Neovim — see `docs/window-and-pages.md`, "Terminal programs".

## The terminal in tmux control mode (in progress)

DevHub's terminals are moving from one xterm.js per tmux _client_ (tmux
draws the whole window, status line and pane borders included, into one
grid) to **tmux control mode** (`tmux -C`, the protocol iTerm2's integration
uses): one control client per session, DevHub keeps a terminal engine per
_pane_, fed by that pane's `%output`, and draws every pane itself with the
Neovim editor's cell painter (`shell/neovim/painter.ts`). Panes, borders,
the status line and the window tabs become DevHub's; tmux keeps the
sessions, the processes, the layout and the key bindings.

What tmux does not draw for a control client — `display-popup`,
`display-menu`, `command-prompt` / `confirm-before`, choose-tree and copy
mode — DevHub draws itself (phase 3). The spike that settled the
architecture measured, with four panes streaming, 0.14 MB/s to the page
against 3.3 MB/s (tmux repaints side-by-side panes whole for a normal
client), the tmux server at 7.4% CPU against 19.1%, and key-to-echo p99 of
8.5 ms against 20.6 ms beside a streaming pane.

### The engine: libghostty-vt

The per-pane engine is **libghostty-vt** 1.0.0 (Ghostty's terminal core,
MIT, compiled to wasm32), not headless xterm.js. Both were measured on the
same inputs, under Electron 43's V8 (`ELECTRON_RUN_AS_NODE`), 200×50 panes,
on a 4-core Linux machine at load ~1. Each engine produces what the painter
takes — per dirty row, each cell's text (a grapheme whole, `""` for a wide
character's right half) and an interned style id, and the cursor — so the
read cost is DevHub's real one, not a library's best case.

| | xterm.js 6.0.0 headless | libghostty-vt 1.0.0 (ReleaseFast, `simd128`) |
| --- | --- | --- |
| parse, colored `ls -lR` log (13.6 MB) | 68 MB/s | 45 MB/s |
| parse, full-screen truecolor TUI redraws (16 MB) | 92 MB/s | 53 MB/s |
| parse, CJK / emoji / combining text (8 MB) | 48 MB/s | 34 MB/s |
| the same three with a frame read every 256 KiB | 59 / 60 / 47 MB/s | 39 / 27 / 26 MB/s |
| read a whole 200×50 viewport for the painter | 1.15 ms p50, 2.4 p99 | 2.8 ms p50, 7.0 p99 |
| one echoed key: write + read its dirty row | 9.5 µs p50, 95 µs p99 | 27 µs p50, 140 µs p99 |
| memory per pane, 10 000 lines of scrollback | 30.6 MiB RSS | 16.0 MiB RSS |
| start-up | 11 ms to load the module | 7.5 ms to compile, instantiate and check it |
| **cell widths that agree with tmux 3.7c** (20 graphemes: CJK, emoji with skin tones, ZWJ families, flags, VS16, combining marks, ZWSP) | **14–16 of 20** in every mode (default, `unicode11`, `unicode-graphemes`) | **20 of 20** |

A first round ran on the only wasm reachable then (npm's
`@gkoreli/ghostty-vt-js` 0.6.0: a pre-1.0 snapshot, ReleaseSmall): the
official ReleaseFast build parses the TUI stream twice as fast (26 → 53
MB/s) and the CJK text 1.4 times as fast, and the width agreement and the
memory are the same.

Why libghostty-vt, in the order that decided it:

1. **The grid has to be tmux's.** In control mode the engine does not
   decide where text goes — tmux does, and the program (zsh, Neovim, an
   Agent's TUI) moves its cursor by tmux's arithmetic. An engine that counts
   a skin-toned emoji, a ZWJ family or a flag differently from tmux puts
   every character after it in the wrong column, and the line stays wrong
   until it is redrawn. tmux 3.7 clusters graphemes the way Ghostty's mode
   2027 does; xterm.js disagrees on 4–6 of 20 common sequences in every
   unicode mode it has. DevHub turns mode 2027 on in every pane's engine (it
   is how tmux behaves whatever the program asks). DevHub's tmux is built
   without utf8proc (`scripts/build_tmux.py`), so on macOS tmux takes the
   base widths from libc's `wcwidth`; where macOS and Ghostty's tables
   differ, tmux's `codepoint-widths` is the lever, set by DevHub, so the
   two still agree.
2. **What DevHub needs is in its API, not behind internals.** Dirty rows
   come from its render state (xterm.js has them only through
   `_core._inputHandler`); OSC 8 hyperlinks are readable per cell; semantic
   prompts (OSC 133) are tracked and `select_output` selects one command's
   output — the prefix+y / Y copy in the person's tmux.conf; selection
   gestures (word, line, between) are the library's; the mouse encoder
   follows the pane's modes; snapshots serialise a pane's whole state.
   With xterm.js headless every one of those is DevHub code or a private
   field.
3. **Half the memory per pane.** It matters with many panes and long
   scrollback.
4. **Speed is enough.** xterm.js parses 1.3–1.7 times faster and reads a
   viewport in less time, and that is what libghostty-vt costs. It stays
   within budget: a full viewport is 2.8 ms of a 60 Hz frame's 16.7, an echo
   27 µs against milliseconds of tmux round trip, and parsing runs off the
   page (phase 2 runs the engines beside the control client, not in the
   renderer). A pane's output in control mode is the program's own bytes,
   not tmux repainting a whole client, so the rates above are far beyond
   what a pane produces outside a `cat` of a large file.

What it costs: DevHub owns a small binding over a C ABI (pointers, a wasm
memory that grows and never shrinks — a closed pane's memory is reused by
the next one, not returned), and the wasm is a build artefact, not a
JavaScript package that updates itself. The binding reads the library's
own `ghostty_type_json()` (every struct's layout) and `ghostty_build_info`
(version, features) at load, so an ABI that moved is a refusal at start,
not wrong colours.

Not deciding factors: key encoding (in control mode keys reach the program
through `send-keys`, which tmux encodes for the pane — Kitty keyboard
included); Kitty graphics (not in a freestanding wasm build, and only
reachable through tmux's `allow-passthrough` in any case); reflow (tmux reflows; DevHub resyncs a
resized pane with `capture-pane`); search (not in the 1.0 ABI; DevHub's
copy mode searches the pane's text itself).

### Where the wasm comes from

`scripts/build_libghostty_vt.py` builds it from Ghostty's `vt-1.0.0` tag
(commit `0fa3d577`, checked after the shallow clone) with the Zig the tag's
`build.zig.zon` requires (0.17.0, from PyPI's `ziglang`): `-Demit-lib-vt
-Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dstrip=true`. The
wasm target's default CPU enables `simd128` (`src/build/Config.zig`;
`ghostty_build_info`'s SIMD flag is false because it describes Ghostty's
C++ SIMD dependencies, which do not build for wasm). Dependencies are
downloaded by the script, hashed by `zig fetch` and compared with the hash
Ghostty's manifests name, unpacked by that hash and given to `zig build
--system` with an empty cache, the offline route PACKAGING-LIBGHOSTTY.md
documents; Zig's own fetcher is not used, since it could not speak through
the proxy of the machine this was built on. The result is 1.26 MB.

The module is committed (`apps/desktop/vendor/libghostty-vt/`, with
`BUILD.json`: tag, commit, Zig, flags, sha256, which a test checks), not
downloaded at build time the way tmux and bash are fetched onto SSH hosts
(`product-overrides.json`): those are per-platform binaries a DevHub
installs on another machine at run time; this is one file, the same
everywhere, that every build needs, small enough to keep in the tree, and
reproduced byte for byte by the script. `build:native` copies it into
`out/vt/`, which the packaged app carries.

### The font, once

Every pane is drawn by the painter Neovim's grids use — the same font
measurement, the same baseline (`alphabetic` at the ascent), the same box
drawing, block and Powerline glyphs and Nerd Font icons. That is also the
fix for the terminal's Source Code Pro baseline: xterm.js' WebGL atlas
draws with `textBaseline = "ideographic"` at the cell's bottom, which sits
2.45 px low at 15 px for Source Code Pro (JetBrains Mono and DejaVu happen
to agree). With the xterm.js path deleted (phase 4) there is no second
path to patch.

### The setting, while both paths exist

`[terminal] tmux_control_mode = true` selects the control-mode terminal;
the xterm.js path stays the default until the new one does everything the
old one does. It reaches the pages with the appearance
(`terminalTmuxControlMode`); a surface reads it when it attaches and asks
main for a control client (`mode: "control"` on the attach). Main runs that
client only in the pty host — the attach argv with `-C`, on pipes, and over
SSH with `ssh -T` rather than `-tt`, since a terminal would echo the
commands and cut them at its line length — and refuses it where the host is
not available. Written to `settings.toml` only when on.

### The surface

With the key on, every terminal surface — a Workspace's, an Agent's — is
`shell/terminal/control/ControlTerminalSurface.tsx`; `TerminalSurface`
picks it by the setting and mounts the other one when it changes.

- **Drawing.** Each pane of the shown window is a grid of the Neovim
  editor's `GridPainter` at the rectangle tmux's layout gives it
  (`paneGrids.ts`): the pane's dirty rows from its engine, its styles as
  highlights (faint ink is mixed half way to its ground, hidden ink is its
  ground). Between panes tmux leaves one cell; a hairline runs down its
  middle. The active pane's cursor takes the program's shape. The theme's
  colours are sent to the engines (the 16 ANSI colours, the cube and the
  greys), and its foreground and background are the painter's defaults.
- **Keys.** By tmux's names (`controlKeys.ts`), so the prefix and the
  bindings are tmux's; Option is Meta per `mac_option_is_meta`, by the
  physical key. Text an IME commits, and a dead key's character, go to the
  active pane as bytes; a paste is bracketed when the pane's program asked.
  Keys typed while a client is being attached are held for it.
- **Mouse.** A click selects its pane; a pane whose program asked for SGR
  mouse reports gets presses, releases and the wheel. Scrolling back
  through history is copy mode's (phase 3).
- **Connection.** As the xterm.js surface (b73a4f71): a session that ended
  is made again every time, and said to be disconnected only when one made
  again ends within 3 s with nothing typed (a key or a paste, not the
  stream); Retry and every connect put the keys in the terminal when it is
  on screen and nothing outside it has them. A surface never shown is not
  attached; a hidden one tells its client, which stops sending rows.
- **The window strip** under the panes is provisional — the session's
  windows, the index in a small keycap, the active one standing out — until
  phase 4's tabs are designed from a mock.
- **Neovim over a pane** (`docs/neovim-editor.md`, "Neovim in a terminal"):
  the page says where each pane is drawn and what it is
  (`reportTerminalPanes`), and the overlay is placed from that, with no
  polling. Checked in the app with the person's Neovim config and
  tmux.conf: `nvim` in a pane, a split and a zoom from the overlay, another
  window hiding it, `C-q C-q` reaching Neovim, a click beside it and a key
  that takes the keys back, `git commit`, `devhub -g` into the
  `devhub-nvim` window and `:restart` there. From the socket named to the
  UI attached: 370 ms, most of it the overlay's page starting.

- **An SSH host** (checked against a local sshd, DevHub's tmux 3.7c
  installed on the host as it is for any host): the control client runs as
  `ssh -T <host> -- … tmux -C attach-session`, typing and splits as here, a
  `nvim` on the host drawn over its pane through the forwarded socket. With
  the connection killed on the host's side, the surface attaches a new
  control client by itself, and the Neovim's overlay comes back with it: a
  new client name in the page's report is the connection back, so a pane
  whose UI ended with the old one is tried again. Seen on the way: a host
  whose non-interactive shell has no UTF-8 locale (no `AcceptEnv LANG`)
  gets tmux's answers with DevHub's field and record separators turned into
  `_`, and every listing fails as "an unterminated record"; macOS's
  `SendEnv LANG LC_*` and Debian's `AcceptEnv` make that rare, but it is
  not DevHub's to rely on, so every tmux DevHub runs is told UTF-8 with
  `-u` (both paths, here and on hosts).

Measured in the app (Xvfb, the person's tmux.conf, zsh, a busy 4-core
machine at load 6): key to paint p50 6.3 ms, p90 9.0 ms, max 17.3 ms over 40
keys (keydown to the painter's first glyph after it).

### The two paths, side by side

Measured on one machine in one run of the app (Xvfb, software compositing,
4 cores at load 0.4–1.5, the person's tmux.conf, zsh, one Workspace terminal
192×60), switching `tmux_control_mode` between runs. Key to paint is the
keydown in the terminal's page to the first draw after it: the painter's
first canvas call, or xterm.js' rows changing (its DOM renderer: WebGL is not
available under Xvfb, so the old path's WebGL renderer is not what this
measures). "Streaming" is three panes beside the typing one, each writing 500
lines of 100 columns a second; CPU is per process kind over 20 s, in % of
one core. Throughput is `cat` of a 29.7 MB, 300 000-line file until the
shell's next command runs.

| | xterm.js path | control mode |
| --- | --- | --- |
| key to paint, idle (60 keys) | p50 7.5, p90 13.3, p99 19.9 ms | p50 6.2–6.4, p90 7.2–12.1, p99 18.0–20.6 ms |
| key to paint beside 3 streaming panes (120 keys) | p50 7.4, p90 14.9, p99 21.2 ms | p50 6.1–6.8, p90 15.8–17.6, p99 21.7–22.4 ms |
| CPU while streaming: renderers | 29.9–30.4% | 17.3–18.6% |
| … GPU process (compositing) | 9.0–9.2% | 36.0–39.5% |
| … pty host / tmux server / main | 4.8 / 2.4–2.6 / 2.7–2.9% | 5.5–5.7 / 1.3 / 2.0–2.1% |
| `cat` 29.7 MB | 1.06–1.10 s | 1.74–1.85 s |
| CPU during the `cat` (first 8 s): pty host / tmux server | 6.0–6.9 / 13.1–13.9% | 16.5–18.2 / 15.4–16.9% |

What it says: keys reach the screen as fast or faster in control mode, and
the page's own work under streaming is down by 40%; tmux does less (it no
longer redraws a client's whole window). Against that, every frame the
painter draws is a canvas the compositor uploads, and in software that is
the GPU process's 36–40% of a core; a `cat` of a large file takes 0.7 s
longer, the time the pty host's engine spends parsing it (the engine reads
every byte; xterm.js' path drops what tmux coalesced away).

### Next (phase 2 still open)

- The painter's frames cost the compositor more than xterm.js' DOM rows
  under Xvfb (below); to be measured again on the person's Mac, where
  xterm.js draws with WebGL and both composite on the GPU, before the
  xterm.js path is deleted.
- `faint` is drawn mixed, not with a font weight; the cursor is a block
  over the text (difference blend), not the text drawn in the cursor's
  colour as Neovim's is.

### Handoff: where phases 3 and 4 start

**State (phase 3 under way).** The Neovim overlay, an SSH host, the reload
port and the side-by-side measurement are done (above). Of phase 3,
`display-popup` is done (below, "What waits on a control client"); next, in
this order: `command-prompt` / `confirm-before`, `display-menu`, the
choosers, copy mode. The look of each follows the mock sent for review
(`tmux-chrome/phase3/mock.html` in the work's scratch area: a float in one
frame for popup, menu and chooser; a one-line prompt at the terminal's
foot; copy mode in place with tmux's `[n/m]` badge); keep each look in one
CSS module of tokens, as `popup.css` is, so a change after the review stays
small, and remove each guard as its piece lands. A prompt's answer, a
menu's item and a chooser's choice are run as commands of the control
client; tmux expands every format (`display-message -p -t <pane>`) and
keeps the prompt history (`show-prompt-history`). Before phase 4 deletes
the xterm.js path: the `cat` throughput (1.8 s against 1.1 s) and the GPU
process's compositing (36–40% against 9%) are to be profiled and measured
on the Mac.

- **Popups.** A popup's command runs as the popup's pane's: `$TMUX_PANE`
  and "the current pane" are the pane that opened it, which is what the
  person's `bind m` (`tmux move-pane` with no `-s`) relies on. Settled by
  experiment (tmux 3.7c, a server of its own): run in a temporary window or
  a session of its own, the command's tty is that pane's, and tmux takes
  the pane whose tty a client is on as "the current pane" before
  `$TMUX_PANE` — `list-windows` listed the popup's session and
  `move-pane -t :2` failed, `TMUX_PANE` overridden or not. Run in a pty of
  DevHub's own, which is no pane's, with the opener's `TMUX` and
  `TMUX_PANE` in its environment — what tmux's own popup job is — tmux
  falls back to `$TMUX_PANE`: `list-windows` listed the opener's windows
  and `move-pane -t :2` moved the opener. So the pty host runs the popup's
  command itself (on a host, in a pty there: `ssh -tt`), in the opener's
  directory (`-d`, else `pane_current_path`), and the page draws it as a
  float with an engine of its own. The guard (`keyGuard.ts`) already knows
  which binding was pressed and its command; that is where a popup would
  be started instead of refused. The look is mocked (`phase3/mock.html` in
  the work's scratch area, sent for review) and waits for the person.
- **Menus, prompts, confirm-before.** The binding's command is known at
  the guard; DevHub draws the menu or prompt (mock first, Japanese
  annotations) and runs the chosen item, or the prompt's template with
  `%%` filled, as a command of the control client.
- **Choose-tree / w / s.** `list-sessions`, `list-windows -a` and
  `list-panes -a` give the tree; DevHub draws it and runs `switch-client`
  / `select-window` / `select-pane`.
- **Copy mode.** DevHub-side, on the engine's scrollback (each pane keeps
  2000 lines; `capture-pane -S -` gives the rest). The person's
  copy-mode-vi table (`list-keys -T copy-mode-vi`) says what each key does;
  the libghostty-vt selection API (word, line, `select_output` by OSC 133
  marks) carries the y / Y copies. `%paste-buffer-changed` is where a
  copy that tmux made (`copy-pipe`, `load-buffer -w`) reaches the system
  clipboard.
- **Tabs (phase 4).** The window strip's data is `layout.windows` (index,
  name, active, zoomed); the person's `window-status-format` and
  `window-status-current-format` can be read with `show -gv` and expanded
  per window with `display-message -p -t @<id>`, as data, never by
  reading painted cells. Mock first; then delete the xterm.js path, the
  pty clients of the pty host and the `tmux_control_mode` key together.

### What waits on a control client, until DevHub draws it

A control client cannot answer what tmux would draw for a normal one, and
some of it waits on the client: a `display-popup` holds the client's
command queue until its command exits (an fzf popup nobody can see never
does), `display-menu` and `display-panes` take the next key, and a
`command-prompt` or `confirm-before` waits for an answer typed into a prompt
that is never shown; every command DevHub sends after it waits too. Copy
mode and the choosers do not wait, but take every key into a mode nobody
sees.

Phase 3 replaces this piece by piece. **`display-popup` is DevHub's now**
(`main/ptyHost/control/popup.ts`): a binding that is one `display-popup`
(as `list-keys` writes it, parsed by `tmuxCommand.ts`) is not sent; the
pty host opens a pty of its own on the terminal's machine (`OpenSpec.popupLaunch`:
`sh -c POPUP_SCRIPT`, planned by the machine as the control client is, so
`ssh -tt` on a host) and runs the command there as tmux runs a popup's job:
the opener's directory (`-d`, else `pane_current_path`), `TMUX` and
`TMUX_PANE`, the session's `PATH` (else the server's), `default-shell -c`.
`-w`/`-h`/`-x`/`-y` are placed against the client's size as tmux does
(`C`, cells, percentages; `-y` is the last line), `-T` and `-d` are expanded
by tmux, `-E`/`-EE` close it on exit, without them a key closes it once its
command has exited, and `-B` drops the border. Its screen is an engine of
its own (no scrollback); the page draws it as a float over the panes
(`paneGrids.ts`, grid 1, z 50) in a frame whose look is `popup.css` alone,
and while it is open every key is its, the prefix too. Checked in the app:
the person's `bind m` (fzf over `tmux list-windows`, then `tmux move-pane
-t :N`) listed the opener's windows and moved the opener; on an SSH host the
popup ran on the host with the opener as `TMUX_PANE`. A Neovim drawn over a
pane is hidden while a popup is open (the overlay is a view above the page).
Not yet: `-e`, `-b`/`-s`/`-S` styles, the mouse in a popup. Seen on the way:
a host's pane finds the host's own `tmux` on its PATH, not DevHub's (on the
test host a 3.4, which cannot talk to the 3.7c server), in a popup and in a
pane alike.

**`command-prompt` and `confirm-before` are DevHub's too**
(`main/ptyHost/control/prompt.ts`), a binding that is one of them and
nothing else. tmux keeps a prompt's buffer on the client and says nothing of
it to a control client, so the line is edited in the pty host by tmux's own
rules, `status_prompt_key` and `status_prompt_translate_key` ported key for
key (the `status-keys` emacs table and the vi one with its two modes,
`word-separators`, `C-w`/`C-y`, `C-t`, `C-v`, Tab completion of commands,
aliases, options and layouts), and the page draws it as one line over the
panes' last row (`prompt.css`), where tmux draws its prompt. The prompt and
its `-I` input are expanded by tmux against the active pane
(`display-message -p`); Up/Down walk tmux's history of the prompt's `-T`
type (`show-prompt-history`). What the answer *means* is left to tmux: the
binding is run as written with `-b` (so it does not hold the client's queue)
and the answer typed into tmux's own prompt on the same command line —
`send-keys -K C-u`, the answer with `-l`, `Enter`, once per `-p` prompt; for
`-1`, `-k`, `confirm-before` the key itself, for `-N` the digits and the key
that ended them. tmux fills the template (`%%`, `%1`, `-F`), adds the answer
to its history and runs it, exactly as for a key typed into its status line;
a `#` or `%` typed stays literal, since nothing is re-expanded. An
incremental prompt (`-i`) is tmux's from its start, each key typed into it as
it is typed here. What is typed at the bare `:` prompt is looked at first as
a key's binding is: a popup or a prompt is DevHub's, a command that would
wait is refused. An error from the command, and a `display-message` to the
client, are said in the notice, where tmux would put them in its status
line. tmux's completion menus (`-t` targets, window lists) are not drawn.

**`display-menu` is DevHub's** (`main/ptyHost/control/menu.ts`), a binding
that is one, or one `if-shell -F` that holds one (tmux's right-click binding
on a pane is `if -F -t= '#{||:#{mouse_any_flag},…}' {…} { display-menu … }`:
tmux decides the format at its target with `display-message -p`, and DevHub
takes the arm). The title, every item's name and its command are expanded by
tmux against the menu's target pane, as `menu_add_item` expands them (with
`%` doubled, since `display-message` runs `strftime` first and
`format_single` does not); items are kept as tmux keeps them (no item whose
name expands to nothing, `-name` shown and not chosen, no separator first or
twice); the keys are `menu_key_cb`'s (an item's key, Up/Down and `k`/`j`,
Home/End and `g`/`G`, PPage/NPage, Enter, Escape/`q`/`C-c`/`C-g`); `-x`/`-y`
are placed by `cmd_display_menu_get_pos`'s rules (`C`, `P`, `R`, `M`, numbers,
`#{popup_*}`), except that `W`/`S` name tmux's status line, which is DevHub's
window strip below the panes: `-x W` is over the window's tab, `-y W`/`S` the
panes' foot. The page draws it as a float in the popup's frame
(`menu.css`), keys right-aligned without tmux's brackets, the chosen item in
the selection colour; a click on an item chooses it, a click outside closes
it, and nothing needs the mouse. A right-click that the pane's program does
not take runs tmux's `MouseDown3Pane` with the click as its mouse (`-t =` is
that pane, `-x M -y M` the cell), and one on a window's tab its
`MouseDown3Status`. The chosen item's command is tmux's: one that would wait
(a prompt in the window menu's Rename) is DevHub's again, the rest is run as
text by `confirm-before -b -c y <command>` and a typed `y` — tmux parses and
runs it as a binding's, on the client's queue with no state, and it answers
once whatever the command holds. tmux runs an item with the menu's target as
the current pane; a control client's commands have its active one, so the
target is selected first when it is another (a right-click on another pane):
the one difference, chosen over an item acting on the wrong pane. Items that
read the mouse's word or line (`#{mouse_word}`) expand to nothing, since a
format DevHub asks tmux for has no mouse event, and are left out as tmux
leaves out any empty item.

The rest, until phase 3 draws them, is not let do that
(`main/ptyHost/control/keyGuard.ts`):

- DevHub keeps its own copy of where tmux is in its key tables, from the
  bindings `list-keys` gives (read at attach, and again while a prefix waits
  if they are more than 5 s old), the prefix and `prefix2`, `repeat-time`,
  repeats and `switch-client -T`. The prefix is held until the key after it
  says which binding it is; a binding whose command waits on the client
  (the commands above, their aliases, inside an `if-shell` too) is not sent,
  and the page says so quietly ("C-q m: display-popup is not available in
  control mode yet"). A table tmux was already in is reset. Keys typed
  before the bindings were first read wait for them.
- A pane left in a mode (copy mode, a chooser) once the binding that entered
  it has finished — 250 ms after its last mode change, since tmux says so
  while the binding still runs — is taken out of it (`copy-mode -q`), and
  that is said. prefix+y / Y, which enter copy mode, select by the prompt
  marks and `copy-pipe-and-cancel` in one binding, are done by then and are
  untouched.

A popup's command run in a temporary split or window would run as that
pane's, not the opener's (see the handoff above): it is to run in a pty of
DevHub's own.

### Phases

1. **Engine** — done (above).
2. **Control-mode core** behind the setting: one control client per
   session in a utility process, the panes' layout, an engine per pane fed
   by `%output`, flow control (`pause-after`, resync by `capture-pane`), the
   painter drawing each pane with native borders, keys through `send-keys`
   (prefix, the IME, the mouse), hidden panes not drawn, the Neovim overlay
   on exact pane rectangles, SSH hosts.
3. **What tmux does not draw for control clients**: popups (the command in
   a pane DevHub shows as a float), menus, prompts, choose-tree, copy mode
   with the person's copy-mode-vi bindings and the prompt-mark copy.
4. **The status line as DevHub's tabs**, then control mode as the only
   terminal: the xterm.js path and the setting deleted.
