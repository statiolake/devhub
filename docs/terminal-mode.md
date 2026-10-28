# Terminal mode: a tmux editor area instead of a VS Code workbench

DevHub hosts a patched VS Code and gives every Workspace a workbench of its
own. Terminal mode is the other answer to "what is in the editor area": no
workbench at all, and in its place the Workspace's own tmux session — the same
`ws-<digest>` session the editor's DevHub terminal tabs attach to — drawn by
DevHub's own terminal surface. Neovim does not occupy it. It is a terminal; the
person may run Neovim in it, or anything else.

DevHub is built assuming Neovim is the editor in this mode. There is no
`editor = "vscode" | "neovim"` setting and no plan for one: what is chosen is
whether a workbench exists, and the one place DevHub itself needs an editor —
a file jump — is answered by a Neovim DevHub manages (below). The person's own
Neovim configuration stays in their dotfiles; DevHub never writes it.

## The setting

```toml
[general]
workbench = "terminal"   # or "vscode", the default
```

`general.workbench` is application level, like `appearance.title_bar`: it is
read **once, at launch**, from the file's text before anything is built
(`workbenchModeIn` in `model/config.ts`, `main/shell/workbenchMode.ts`), and a
change takes effect the next time DevHub starts. The Settings window offers it
under General ▸ Editors ("Editor area") and says so. A file that will not parse
answers with the default, for the same reason `titleBarModeIn` does: the real
load runs moments later on the same text and is what reports the problem.

Why a restart rather than a live switch: everything about a workbench — the
lifecycle's plan, the VS Code services it is built through, the terminal
colours it reports, the views attached to it — would have to be torn down or
brought up in one step, and a Workspace half in one mode and half in the other
is a state nobody needs. One mode per process is one answer everywhere.

## What changes in the window

The layout (`main/shell/windowLayout.ts`) has a child kind for it,
`editorTerminal`, keyed by the Workspace's editor key exactly as a workbench
is. Everything that is "where the editor is" is answered for it the same way:

| Arrangement                | VS Code mode                  | Terminal mode                                  |
| -------------------------- | ----------------------------- | ---------------------------------------------- |
| Workspace selected (full)  | its workbench                 | its editor terminal, the whole content area    |
| Split (`Cmd+Q Z`)          | workbench left, Agent right   | editor terminal left, Agent right              |
| Agent alone                | Agent; workbenches stay built | Agent; editor terminals stay attached, hidden  |
| Keyboard `editor` half     | the workbench                 | the editor terminal                            |
| `Cmd+Q E`, `Cmd+Q O`       | to / through the workbench    | to / through the editor terminal               |

The editor terminal is the **Agent terminal pane's machinery reused**: one
`pane.html` view per Workspace (`ShellWindow.syncEditorTerminalViews`), whose
fragment names the Workspace (`#workspace:<id>`) instead of an Agent terminal,
mounting the same `TerminalSurface` on the surface key
`workspace-terminal:<workspaceId>` — a key the terminal service has always
resolved to the Workspace's `ws-` session. There is no second terminal
implementation; chords, the IME, zoom, scroll sensitivity, the theme and the
attach/detach protocol are the Agent pane's. A view is made the first time its
Workspace is shown and kept (hidden, attached) until the Workspace goes, so
coming back is a move rather than a reattach and a reflow, the way an Agent
terminal's view is kept.

A click into it is the editor half taking the keyboard (`ContentFocus`
`editor`), so the split's selected half follows the click as it does for a
workbench.

### The shell exiting is the close button

When the editor area's session ends under the person — `exit` in its last
shell, or the session killed — it is the Workspace's close button being
pressed (`main/shell/editorTerminalExits.ts`), through the one close path
(`closeWorkspaceOrWorktree`): a Workspace with nothing to lose closes, and one
with something to ask about (busy Agents, running programs, a dirty worktree)
raises the same sheet the button does. If the Workspace stays — the question
is cancelled, the close fails — or cannot be closed (Scratch never is), the
view is started over in place, which makes a fresh `ws-` session. A client
that ended while its session still runs (detached with tmux's own keys) is
attached again.

Only a tmux client that ended on its own counts
(`AttachmentManagerOptions.onEndedByItself`): everything DevHub ends itself —
closing the Workspace, quitting, moving the socket, a view going or reloaded —
stops the client first, as a detach. Nothing is acted on once DevHub is
shutting down, and a terminal that keeps ending as soon as it starts is
started over at most three times in thirty seconds, then left with the
surface's own Retry.

In VS Code mode the editor's Vim does the same with its last window: `:q`
there, and `:qa` `:wqa` `:xa`, press the same close button
(`main/shell/workbenchCloseRequests.ts`; see [Vim](vim.md#closing-a-window-and-quitting)).

## Local only

Terminal mode serves folders on this Mac and nothing else: an Agent that needs
another machine drives it itself, through tmux and `ssh`, and setting a remote
machine or a container up for that is the job of separate tools (`dockim`,
`sshim`), not DevHub's. SSH Workspaces and dev containers remain VS Code mode's
(`docs/remote-ssh.md`, `docs/remote-containers.md`).

- **SSH Workspaces are not offered.** The Open Workspace picker has no
  "SSH: Connect…" row and lists no SSH hosts, and opening a folder on a host
  by any other way (`openFolder`, where every way meets) is refused with
  "SSH Workspaces are not available in terminal mode. Use VS Code mode to open
  them." One restored from an earlier VS Code mode run stays in the Sidebar:
  its editor area draws that sentence (the window's own page, in the rectangle
  a view would be laid into) and no view is made, and a file jump to it is
  refused with the same sentence. Its Agents and their terminals work as
  before — those are tmux sessions on the host that do not depend on a
  workbench.
- **A dev container is only where a workbench runs.** A Workspace's terminals,
  Agents and git are where its folder is whether or not its editor is
  attached to a container (`EditorAttachment`), so in terminal mode a
  Workspace whose editor was in a dev container is simply the local folder it
  is: its editor area is its `ws-` session on this Mac, its file jumps go to
  its managed Neovim, and its row wears no container mark. The attachment is
  kept, and is what VS Code mode opens next time. Reopen Editor in Container /
  Locally is not offered, and `devhub` run inside a container is refused with
  "Dev containers are not available in terminal mode. Use VS Code mode to
  reopen a folder in its container."

## No workbench is created

Every workbench comes from one executor, `AppController.reconcileWorkbenches`
over the lifecycle's plan (`workbenchLifecycle.ts`). In terminal mode it plans
nothing: `wanted` is empty, so nothing is opened, nothing sleeps, nothing is
capped, and the minute check has nothing to do. The other doors are closed as
well, so that a workbench cannot appear by a side entrance:

- `scratchWorkbench`, `selectedWorkbench` and `workbenchReady` — the callers
  that wait for "the" workbench of a folder — refuse with a sentence instead
  of waiting for an open that will never come.
- VS Code's own `openInBrowserWindow` (a request no DevHub entrance makes in
  this mode, but an extension-less VS Code main process can still be asked) is
  answered by selecting the Workspace and opening nothing.
- Reopening an editor in or out of a dev container is refused.

VS Code's main process still runs: it is what DevHub is built inside, and the
`devhub` CLI's extension commands still talk to it. What does not exist is any
renderer, extension host or remote extension host.

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
area, and opens the file over RPC.

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
close's `editor` step (the step a workbench's unload is in VS Code mode). Its
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
`routeAgentOpen`); what changes is what is done with the answer
(`AppController.openRouted`).

| Entrance                                         | VS Code mode                                   | Terminal mode                                                 |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `devhub <file>` on this Mac                      | the containing Workspace's workbench / Scratch | that Workspace's managed Neovim / Scratch's                   |
| `devhub -g <file>:<line>:<col>`                  | caret at the position                          | cursor at the position                                        |
| `devhub --wait <file>`                           | `filesToWait`                                  | buffer autocommands delete the marker; DevHub on server death |
| `devhub <folder>`                                | Workspace selected, workbench shown            | Workspace selected, editor terminal shown                     |
| Conversation file link                           | split beside the Agent, workbench in front     | split beside the Agent, editor terminal in front, Neovim      |
| Finder Open With / Dock drop / `open -a`         | via `openFromCli`                              | via `openFromCli`, as above                                   |
| `devhub` on an SSH host                          | that Workspace's remote workbench              | refused: not available in terminal mode                       |
| `devhub` in a dev container                      | the window attached to that container          | refused: not available in terminal mode                       |
| An SSH Workspace                                 | its workbench                                  | refused, as above                                             |
| A local Workspace whose editor is in a container | its workbench, in the container                | its managed Neovim, on this Mac                               |
| VS Code's own open (`openInBrowserWindow`)       | DevHub's Workspace / Scratch rule              | Workspace selected; no workbench is opened                    |

## What is hidden or inert in terminal mode

None of these error; they are not offered, or have nothing to act on.

- **Everything that lives inside a workbench**: DevHub Vim, tidy, Copilot, the
  bridge and remote extensions, VS Code's menus and command palette, the
  integrated Browser, diff and review editors. There is no workbench for them
  to run in.
- **Workbench hibernation and the awake cap** (`general.workbench_hibernate_minutes`,
  `general.workbench_awake_max`): the plan has nothing to put to sleep. The
  Settings rows stay, with a note that they apply to VS Code mode.
- **View ▸ Toggle Integrated Terminal** and its chord: not in the menu.
- **Reopen Editor in Container / Locally** on a Workspace row: not in the menu.
- **SSH: Connect…** and the SSH hosts in the Open Workspace picker: not listed.
- **Workbench placeholders** (asleep, waking, restarting, gave up): never
  raised.

Agents, Agent terminals, the Sidebar, notices, chords, usage, the `devhub`
command and every tmux-side feature (`devhub --tell terminal …`, moving an
Agent's terminal to the editor — which now lands in the editor area, in view)
are unchanged.

## Theme

The chrome and the terminal palette come from the VS Code colour theme
DevHub's own settings name (`appearance.theme_dark` / `appearance.theme_light`,
read by `colorThemeCatalog.ts` and `shellTheme.ts` from the extensions on
disk), not from a workbench's report. That source never needed a workbench —
it paints the window from a cold start and with every workbench asleep — so
terminal mode uses it unchanged: the editor area's terminal is an Agent pane's
surface and wears the same `terminal_theme` (the theme's terminal colours by
default, or the configured palettes).

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
- **The setting's name.** `general.workbench` names what is chosen (whether a
  workbench exists). If a third mode ever appears this stays right; an
  `editor = …` would not.
