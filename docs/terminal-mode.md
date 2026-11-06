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

## Retained, not in use: the terminal view

The editor area used to be able to show the Workspace's own `ws-` tmux session
instead, drawn by DevHub's terminal surface, with file opens going to a managed
Neovim in that session. That code is **retained in the tree, not in use**:
nothing shows the view or routes a file to it any more.

- `main/shell/shellWindow.ts` (`syncEditorTerminalViews`, the `editorTerminal`
  child kind of `windowLayout.ts`, `SurfaceArrangement.view`) — no caller asks
  for a terminal view.
- `main/shell/editorTerminalExits.ts` — unreferenced.
- `main/editor/managedNeovim.ts` (below) — built, given the theme, and closed
  with its Workspace, but never asked to open a file.

What `devhub <file>`, a conversation file link and Send to Agent's reference
open in is always the Workspace's workbench (below, "File-open routing").

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

## The managed Neovim server (retained, not in use)

A file jump needs an editor that DevHub can address. DevHub keeps **one
Neovim per Workspace of its own** — separate from any Neovim the person starts
in the same session (duplicates are fine and expected).

### Where it runs

The first jump into a Workspace opens a **new tmux window** in that Workspace's
`ws-` session (`new-window -P -F '#{pane_id}' -c <root> -- <nvim> --listen
<socket>`), not a split of the active window. A split would shrink whatever
the person has open — usually a shell they were typing in — to half its width,
and take the editor down to half the area it is for; a window is the full
editor area, appears in the person's window list like any other, and leaves
their layout alone. Later jumps `select-window` + `select-pane` on its pane, so
it is in front however the person has moved around since.

Then DevHub selects the Workspace (beside the asking Agent, for a conversation
link, exactly as the VS Code routing does), puts the keyboard in the editor
area — its terminal view — and opens the file over RPC.

### The socket

`<userData>/devhub/nvim/<digest>.sock`, where the digest is the first twelve
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
   that Workspace's marked panes on DevHub's tmux server: activate the pane,
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
`routeAgentOpen`); the file is always handed to that Workspace's workbench
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

The chrome and the terminal palette come from the VS Code colour theme
DevHub's own settings name (`appearance.theme_dark` / `appearance.theme_light`,
read by `colorThemeCatalog.ts` and `shellTheme.ts` from the extensions on
disk), not from a workbench's report. That source never needed a workbench —
it paints the window from a cold start and with every workbench frozen or
discarded — and DevHub's own terminals (Agent panes and their terminals) wear
the same `terminal_theme` (the theme's terminal colours by default, or the
configured palettes).

The programs inside the terminal are told the theme too — `DEVHUB_THEME`,
`DEVHUB_FZF_COLORS` and the rest in every new pane's environment, a
`theme.json` that is rewritten on every change, and `User DevhubTheme` in the
managed Neovim — see `docs/window-and-pages.md`, "Terminal programs".

## Open questions

- **The terminal view.** Retained, not in use (above). Delete it, or bring it
  back as something other than the editor area?
