# The editor area: a Workspace's terminal, and its VS Code editor on demand

DevHub hosts a patched VS Code and can give every Workspace a workbench of its
own. It does not start one until it is asked for. Every Workspace's editor
area shows, by default, its own tmux session — the same `ws-<digest>` session
the workbench's DevHub terminal tabs attach to — drawn by DevHub's own terminal
surface. Neovim does not occupy it. It is a terminal; the person may run Neovim
in it, or anything else.

`Cmd+Q E` switches that Workspace's editor area to its **VS Code editor**,
starting its workbench the first time, and back. Each Workspace has its own
answer, and remembers it across restarts. `[general] default_view = "editor"`
makes the VS Code editor what a new Workspace starts with (below).

## The model

```text
editor area of a Workspace = terminal (default_view)  ─ Cmd+Q E ─▶  editor (VS Code)
                                                      ◀─ Cmd+Q E ─
```

- **Per Workspace.** `Workspace.editorView` (`model/domain.ts`, the rule in
  `model/editorView.ts`) is `terminal` or `editor`; the intent that changes it
  is `set_editor_view`, raised by main. It does not move the selection:
  switching pages or Workspaces finds each one showing what it showed.
- **Remembered.** The state file writes `editor_view = "terminal"` or
  `"editor"` for every Workspace. No schema bump: an older DevHub reads
  `"terminal"` as its own default and loses at most which view was shown,
  never anything open.
- **The default: `general.default_view`** (`"terminal"`, DevHub's default, or
  `"editor"`). A Workspace with no remembered view shows it: a new Workspace,
  Scratch's new day included, and one from a state file without `editor_view`
  (every file written before this setting, where only `"editor"` was written
  and an absent key meant the terminal; a value that is neither view reads as
  absent). It is given the default as it enters the model
  (`Workspace.adoptDefaultEditorView`, from `AppModel.addWorkspace` and the
  constructor; `hydrateModel` takes the default for the restored ones) and
  remembers it from then on. A change in Settings applies at once to the
  Workspaces made after it (`AppModel.setDefaultEditorView`, from
  `adoptConfig`); the Workspaces already open keep the view they show. With
  `"editor"` the lazy start below is unchanged: only the Workspace on screen
  starts its workbench at launch, and each other one when it is shown.
- **SSH Workspaces have no terminal view.** Their editor area is their VS Code
  workbench on the host, always (`effectiveEditorView`); `Cmd+Q E` in it says
  so (`editor_has_no_terminal`) and changes nothing. The terminal view is a
  folder on this Mac: an Agent that needs another machine drives it itself
  through tmux and `ssh`. Their Agents and those Agents' terminals are as
  always.
- **Dev containers are only where a workbench runs.** A Workspace whose editor
  is attached to a container (`EditorAttachment`) has the terminal view of the
  local folder it is — its `ws-` session on this Mac, file opens to its managed
  Neovim — and its VS Code editor in the container. Reopen Editor in Container
  / Locally from its row switches it to the editor, since that is what was
  asked for; `devhub <file>` inside the container opens in that workbench,
  switching to it.

## The chord

`Cmd+Q E` is `toggle_editor` ("Switch the editor area between the terminal and
VS Code", `model/commands.ts`), the key `focus_editor` had. It keeps that
command's job and adds the switch:

| Where the keyboard is                                   | `Cmd+Q E`                                         |
| ------------------------------------------------------- | ------------------------------------------------- |
| the editor area (the Workspace's row, or its split half) | toggle: terminal ↔ VS Code, the split kept         |
| an Agent, an Agent's terminal, the Sidebar               | go to the Workspace's editor area, showing VS Code |
| an SSH Workspace's editor                                | said: it has no terminal view                     |

The keyboard lands in what is now shown: the terminal's xterm, or the
workbench's active editor group (`focusActiveEditorGroup`, the toggles' landing
in `chords.ts`). A workbench that is still starting takes the keyboard when it
arrives — `ShellWindow.setLayoutState` places the keyboard again whenever the
answer changes.

`devhub --tell run toggle_editor` runs the same command; the app smoke test
does exactly that (below).

## Lazy start, and the lifecycle

Every workbench comes from one executor, `AppController.reconcileWorkbenches`
over the lifecycle's plan (`workbenchLifecycle.ts`). Every Workspace whose
folder is there is wanted, and every one is **lazy** (`WantedWorkbench.lazy`):
absent and not the selected editor, it goes straight to `asleep` with no frame
— "not started: not shown yet" — and nothing is opened. The selected editor is
the workbench of the selected Workspace *only while its editor area shows its
VS Code editor* (`selectedEditorSurfaceKey`); a Workspace on its terminal
selects none.

So:

- **At DevHub start no workbench is started**, unless the Workspace on screen
  shows its VS Code editor (left that way, given it by
  `default_view = "editor"`, or an SSH Workspace), in which case that one — the
  one being looked at — starts, and no other.
- **The first `Cmd+Q E`** makes the Workspace's editor the selected one, and
  the plan opens it (`start`, or `wake` from that never-started sleep). The
  slot shows a spinner, "Starting VS Code…" (`starting`, or `waking` with no
  frame), until the view has loaded; the view is hidden until then.
- **Then it is a workbench like any other.** It counts toward
  `general.workbench_awake_max`, sleeps after
  `general.workbench_hibernate_minutes` away, and is put to sleep by the cap
  when another is woken. Going back to the terminal is being away from it.
  `Cmd+Q E` on a Workspace whose workbench is asleep wakes it (a passing
  `Cmd+Q N/P` landing on one showing its editor still holds the wake for a
  moment, as before). SSH and dev container workbenches never sleep, as
  before.
- A request that needs the workbench — a file routed to it, VS Code's own
  open of a folder, Scratch's empty window, `devhub` inside a container —
  switches that Workspace to its editor first (`selectedWorkbench`), which is
  what makes the plan open it.

VS Code's main process runs from the start: it is what DevHub is built inside,
and the `devhub` CLI's extension commands talk to it. What is not there until
`Cmd+Q E` is any renderer, extension host or remote extension host.

## What changes in the window

The layout (`main/shell/windowLayout.ts`) has a child kind for the terminal
view, `editorTerminal`, keyed by the Workspace's editor key exactly as a
workbench is, and the arrangement says which of the two the editor area shows
(`SurfaceArrangement.view`). Everything that is "where the editor is" is
answered for whichever is shown:

| Arrangement               | Terminal shown                               | VS Code shown                  |
| ------------------------- | -------------------------------------------- | ------------------------------ |
| Workspace selected (full) | its terminal, the whole content area          | its workbench                  |
| Split (`Cmd+Q Z`)         | terminal left, Agent right                    | workbench left, Agent right    |
| Agent alone               | Agent; terminals stay attached, hidden        | Agent; workbenches stay built  |
| Keyboard `editor` half    | the terminal                                  | the workbench                  |
| `Cmd+Q O`                 | through the terminal                          | through the workbench          |

A question the Workspace's own workbench is asking (a close's unsaved-changes
dialog) outranks the terminal: the workbench is drawn while it asks.

The terminal view is the **Agent terminal pane's machinery reused**: one
`pane.html` view per Workspace (`ShellWindow.syncEditorTerminalViews`), whose
fragment names the Workspace (`#workspace:<id>`) instead of an Agent terminal,
mounting the same `TerminalSurface` on the surface key
`workspace-terminal:<workspaceId>` — a key the terminal service has always
resolved to the Workspace's `ws-` session. There is no second terminal
implementation; chords, the IME, zoom, scroll sensitivity, the theme and the
attach/detach protocol are the Agent pane's. A view is made the first time its
Workspace's terminal is shown and kept (hidden, attached) until the Workspace
goes, so coming back is a move rather than a reattach and a reflow.

A click into it is the editor half taking the keyboard (`ContentFocus`
`editor`), so the split's selected half follows the click as it does for a
workbench.

### The shell exiting is the close button

When the terminal view's session ends under the person — `exit` in its last
shell, or the session killed — while the editor area shows it, it is the
Workspace's close button being pressed (`main/shell/editorTerminalExits.ts`),
through the one close path (`closeWorkspaceOrWorktree`): a Workspace with
nothing to lose closes, and one with something to ask about (busy Agents,
running programs, a dirty worktree) raises the same sheet the button does. If
the Workspace stays — the question is cancelled, the close fails — or cannot
be closed (Scratch never is), the view is started over in place, which makes a
fresh `ws-` session. A client that ended while its session still runs
(detached with tmux's own keys) is attached again. Behind the VS Code editor
nobody saw it end, so the hidden view is only started over.

Only a tmux client that ended on its own counts
(`AttachmentManagerOptions.onEndedByItself`): everything DevHub ends itself —
closing the Workspace, quitting, moving the socket, a view going or reloaded —
stops the client first, as a detach. Nothing is acted on once DevHub is
shutting down, and a terminal that keeps ending as soon as it starts is
started over at most three times in thirty seconds, then left with the
surface's own Retry.

In the VS Code editor the editor's Vim does the same with its last window:
`:q` there, and `:qa` `:wqa` `:xa`, press the same close button
(`main/shell/workbenchCloseRequests.ts`; see [Vim](vim.md#closing-a-window-and-quitting)).

## Settings

`general.default_view` (`"terminal"` | `"editor"`, default `"terminal"`) is
the one setting: what a Workspace with no remembered view shows (above).
Anything else is refused as `invalid_default_view`, naming the key; it is the
Settings window's General ▸ Editors ▸ Default view popup.

```toml
[general]
default_view = "editor"   # new Workspaces open in VS Code; Cmd+Q E still switches
```

`general.workbench` (`"vscode"` / `"terminal"`, a restart) is **retired**
(`RETIRED_KEYS` in `model/config.ts`): a file that still has it loads, the key
is ignored and said once at info level, and the next save drops it; its
`"vscode"` is `default_view = "editor"` now, per Workspace and without a
restart. An "open files in" override was considered and left out: opens
follow what is on screen.

The Settings window's General ▸ Editors group says how the two views work;
`general.workbench_hibernate_minutes` and `general.workbench_awake_max` are
there as before.

### The Option key

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

Whatever the value, **Option+¥ on a Japanese (JIS) keyboard types `\`**: as
Meta it would be `ESC \`, and that is how a JIS Mac types a backslash. The
key is recognised by its code (`IntlYen`), so it holds for any layout on that
keyboard.

xterm.js does the encoding (its `macOptionIsMeta`); DevHub decides, per key,
whether that switch is on (`shell/surfaces/optionKey.ts`). The left Option is
followed from its own keydown and keyup, since a letter's keydown does not say
which Option is held; one already held when the terminal took focus counts as
up until it is pressed again. A refused value is `invalid_mac_option_is_meta`.

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

1. **Alive** — the record's connection is open *and* the pane is still one of
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

The rule that picks *which Workspace* is unchanged (`routeOpen`,
`routeAgentOpen`); what is done with the answer follows **what that
Workspace's editor area shows** (`opensInNeovim` in `model/editorView.ts`,
`AppController.openRouted`): the terminal on this Mac → its managed Neovim;
the VS Code editor, an SSH Workspace, or a path on another machine → its
workbench. Scratch is a Workspace like any other.

| Entrance                                          | Terminal shown                                                | VS Code shown                                  |
| ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `devhub <file>` on this Mac                       | that Workspace's managed Neovim / Scratch's                   | the containing Workspace's workbench / Scratch |
| `devhub -g <file>:<line>:<col>`                   | cursor at the position                                        | caret at the position                          |
| `devhub --wait <file>`                            | buffer autocommands delete the marker; DevHub on server death | `filesToWait`                                  |
| `devhub <folder>`                                 | Workspace selected, its terminal shown                        | Workspace selected, workbench shown            |
| Conversation file link, Send to Agent's reference | split beside the Agent, terminal in front, Neovim             | split beside the Agent, workbench in front     |
| Finder Open With / Dock drop / `open -a`          | via `openFromCli`, as above                                   | via `openFromCli`                              |
| `devhub` on an SSH host, an SSH Workspace         | — (always VS Code)                                            | that Workspace's remote workbench              |
| `devhub` in a dev container                       | switched to VS Code: the window attached to that container    | the window attached to that container          |
| VS Code's own open (`openInBrowserWindow`)        | switched to VS Code                                           | DevHub's Workspace / Scratch rule              |

## Theme

The chrome and the terminal palette come from the VS Code colour theme
DevHub's own settings name (`appearance.theme_dark` / `appearance.theme_light`,
read by `colorThemeCatalog.ts` and `shellTheme.ts` from the extensions on
disk), not from a workbench's report. That source never needed a workbench —
it paints the window from a cold start and with every workbench asleep — so
the terminal view uses it unchanged: it is an Agent pane's surface and wears
the same `terminal_theme` (the theme's terminal colours by default, or the
configured palettes).

## Open questions

- **Selections.** A link with a range puts the cursor at its start. Should it
  select the range in Visual mode instead?
- **Several clients.** Two clients attached to one `ws-` session share its
  current window, so selecting the Neovim window for a jump also moves any
  other client (a `tmux attach` the person runs in Terminal.app). Acceptable,
  or should the editor area use a grouped session?
- **`devhub --wait` and `:wq`.** `:wq` in the managed Neovim ends the server
  (and the marker with it), and the next jump opens a new window. Should a
  `--wait` jump instead open its buffer in a _new_ Neovim that ends with it,
  the way `git commit`'s editor usually does?
- **The activity mark.** A Workspace's row shows "working" while a non-shell
  program in its session prints, and Neovim redrawing as the person types is
  that. Should an editor (`nvim`, `vim`) in front of a pane count as a prompt
  rather than as work?
- **A hint.** Nothing on screen says that `Cmd+Q E` brings up VS Code; the
  chord help and the command palette list it. Should the terminal view show
  it once?