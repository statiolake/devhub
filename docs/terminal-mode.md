# The editor area: a Workspace's VS Code workbench

Every Workspace's editor area is its own VS Code workbench — a patched VS Code
1.141 window per Workspace, with its own extension host. There is no other view
and nothing to switch: `[general] default_view`, the per-Workspace remembered
view and the `Cmd+Q E` terminal/editor toggle are gone. `Cmd+Q E` is
`focus_editor` again ("Show the editor", `model/commands.ts`): it selects the
Workspace (or Scratch) and puts the keyboard in its workbench, from an Agent,
its terminal or the Sidebar.

How a workbench is started, frozen, thawed and discarded — and what that costs
— is `docs/window-and-pages.md`, "What it costs". In short: none starts until
it is asked for — Enter (or Start) on its editor area's "Editor not running"
placeholder, or a file DevHub is asked to open in it — and `Cmd+Q Shift+E`
stops it again; one that is not on screen is frozen (SIGSTOP) unless it is in
use, and discarded after `general.workbench_discard_minutes` frozen —
unless `general.workbench_freeze = false`, which freezes (and so discards)
nothing.

SSH Workspaces' editors are their VS Code workbench on the host, and a dev
container Workspace's is its workbench in the container, as before. Remote
workbenches are excluded from freezing and discarding for now.

## The other editor: Neovim

With `[general] editor = "neovim"` the editor area is the Workspace's
terminal instead of a workbench: its `ws-` tmux session in a terminal page
(`pane.html#ws:<workspace id>`), which is what DevHub lands on at startup and
when a Workspace is opened or selected. Every Neovim in it — `nvim` typed in
a pane, `git commit`'s, and the `devhub-nvim` window files DevHub opens go
to — is DevHub's GUI drawn over its pane; see
[`neovim-editor.md`](neovim-editor.md). There is no separate Neovim editor
page, no placeholder and nothing to start or stop: `Cmd+Q E` puts the keys
in the terminal (or the Neovim over its active pane), and `Cmd+Q Shift+E`
says there is nothing to stop. A session whose last window closed is made and
attached again at once. Since the terminal is the editor area, Neovim offers
no terminal of DevHub's inside it (`:DevhubTerminal` is gone); Neovim's own
`:terminal` is drawn as any other window's grid.

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

The per-pane engine is **libghostty-vt** (Ghostty's terminal core, MIT,
compiled to wasm32), not headless xterm.js. Both were measured on the same
inputs, under Electron 43's V8 (`ELECTRON_RUN_AS_NODE`), 200×50 panes, on a
shared 4-core Linux machine (absolute numbers are noisy; the ratios held
across runs). The painter's input is the same for both: per cell a
codepoint, a width, a resolved foreground and background and the style
flags — what `paintRow` needs.

| | xterm.js 6.0.0 headless | libghostty-vt (wasm, ReleaseSmall) |
| --- | --- | --- |
| parse, colored `ls -lR` log | 53 MB/s | 43 MB/s |
| parse, full-screen truecolor TUI redraws | 83 MB/s | 26 MB/s |
| parse, CJK / emoji / combining text | 42 MB/s | 24 MB/s |
| read a whole 200×50 viewport for the painter | 0.14 ms | 1.2 ms |
| one echoed key: write + read its dirty row | 2.5 µs p50 / 23 µs p99 | 15 µs p50 / 74 µs p99 |
| memory per pane, 10 000 lines of scrollback | 31.5 MiB RSS | 17 MiB RSS (31 MiB of wasm memory reserved) |
| start-up | 11 ms to load the module | 4.5 ms to compile and instantiate |
| **cell widths that agree with tmux 3.7c** (20 graphemes: CJK, emoji with skin tones, ZWJ families, flags, VS16, combining marks, ZWSP) | **14–16 of 20** in every mode (default, `unicode11`, `unicode-graphemes`) | **20 of 20** (mode 2027 on), 14 legacy |

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
4. **Speed is enough, and it is the build's.** This wasm is size-optimised
   with SIMD off; even so a full viewport costs 1.2 ms (a 60 Hz frame has
   16.7), an echo 15 µs against milliseconds of tmux round trip, and parsing
   runs off the page (phase 2 runs the engines beside the control client,
   not in the renderer). A ReleaseFast build is measured again when it is
   built from the release (below).

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

The plan is the release's own build, `vt-1.0.0` built with the Zig its
`build.zig.zon` names (`pip install ziglang==<that version>`), ReleaseFast.
That build needs the Ghostty sources (github.com/ghostty-org/ghostty) and
its pinned dependencies, which Ghostty serves only from
`deps.files.ghostty.org` (`uucode` is not optional). Neither was reachable
from the machine this was done on (`release.files.ghostty.org` and
`ziglang.org` were blocked too). Until it is, DevHub uses the wasm that
`@gkoreli/ghostty-vt-js@0.6.0` publishes on npm: an unpatched build of the
libghostty-vt C ABI (200 exports, `env.log` its only import, MIT), which
reports itself as `0.1.0-dev`, ReleaseSmall, no SIMD — a snapshot from
before the 1.0 tag, so its option numbers are not 1.0's. Its sha256 is
`7cf0d42c8737137cb49293326e1d69b90de44b3800b9c52f6ba33e252fe171d7`. Moving
to the release build changes the binding's constants and nothing above it.

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
old one does. The key exists only for that transition: when control mode
becomes the only terminal (phase 4), the key and the xterm.js path are
deleted together — no setting is kept for compatibility, and a
`tmux_control_mode` left in a settings file is then refused like any
unknown key.

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
