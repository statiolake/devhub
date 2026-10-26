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

**SSH and dev container Workspaces** are not supported in terminal mode yet.
Their editor area draws "Terminal mode does not support … yet" (the window's
own page, in the rectangle a view would be laid into) and no view is made; a
file jump to one is refused with the same sentence. Their Agents and the
Agents' own terminals work as before — those are tmux sessions on the host that
do not depend on a workbench. Phases 2 and 3 below are what lifts this.

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

| Entrance                                       | VS Code mode                                   | Terminal mode                                                   |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `devhub <file>` on this Mac                    | the containing Workspace's workbench / Scratch | that Workspace's managed Neovim / Scratch's                     |
| `devhub -g <file>:<line>:<col>`                | caret at the position                          | cursor at the position                                          |
| `devhub --wait <file>`                         | `filesToWait`                                  | buffer autocommands delete the marker; DevHub on server death   |
| `devhub <folder>`                              | Workspace selected, workbench shown            | Workspace selected, editor terminal shown                       |
| Conversation file link                         | split beside the Agent, workbench in front     | split beside the Agent, editor terminal in front, Neovim        |
| Finder Open With / Dock drop / `open -a`       | via `openFromCli`                              | via `openFromCli`, as above                                     |
| `devhub` on an SSH host, or in a dev container | that Workspace's remote workbench              | refused: not supported in terminal mode yet                     |
| A Workspace on a host or in a container        | its workbench                                  | refused, same sentence                                          |
| VS Code's own open (`openInBrowserWindow`)     | DevHub's Workspace / Scratch rule              | Workspace selected; no workbench is opened                      |

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

## Later phases: SSH and dev containers by terraforming

Design only; phase 1 implements local Workspaces.

The idea is the one the remote extension host already follows, taken further:
DevHub brings everything the editor area needs onto the machine — tmux,
Neovim, the person's Neovim config — so the host or container needs nothing
installed and nothing configured.

### Phase 2: SSH

1. **Binaries.** DevHub ships per-arch Linux bundles for x86_64 and aarch64,
   published like tmux's (`scripts/build_tmux.py`, a release keyed on the
   version):
   - tmux: the existing static musl build, already installed at
     `~/.devhub-server/tmux/<version>/`.
   - Neovim: the official release tarball (`nvim-linux-x86_64.tar.gz` /
     `nvim-linux-arm64.tar.gz`) — a plain directory tree, no AppImage, so no
     FUSE dependency. It links glibc dynamically (2.31+ for current releases);
     for hosts older than that, or musl (Alpine) containers, a static musl
     build in the tmux script's style is the fallback — see the open
     questions.
   Installed at `~/.devhub-server/nvim/<version>/` with the same
   marker-then-rename install the server uses, copied with `scp` over the
   connection DevHub already holds.
2. **Config.** At terraform time DevHub packs the local `~/.config/nvim`
   (following symlinks, which is how a dotfiles checkout presents it; without
   `.git`) into a tarball, content-hashed, and unpacks it to
   `~/.devhub-server/xdg/config/nvim` only when the hash changed. The managed
   Neovim and the editor area's panes run with `XDG_CONFIG_HOME`,
   `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under
   `~/.devhub-server/xdg/`, so nothing of the host's own `~/.config` or
   `~/.local` is read or written, and the person's own login on that host
   is untouched.
3. **Plugins and LSP.** The plugin manager bootstraps itself on the host
   from the config (lazy.nvim clones on first start; needs `git` and network).
   Language servers come from mason, on the host, into the XDG data dir. No
   treesitter parser or native plugin prebuilding: the person avoids them,
   and a bundle of native code per arch is exactly the maintenance this design
   avoids.
4. **Editor area.** The editor terminal attaches the host's `ws-` session,
   which already exists for SSH Workspaces (Agents and Agent terminals use the
   host's DevHub tmux today); the surface key resolves to a target on that
   machine and the attachment is the existing remote PTY channel.
5. **Managed Neovim.** Runs on the host, socket under
   `~/.devhub-server/run/nvim/<digest>.sock`. RPC travels over the remote shell
   channel DevHub already has, through a relay: `~/.devhub-server/nvim/<v>/bin/nvim
   --clean --headless -l ~/.devhub-server/share/devhub/nvim-relay.lua <socket>`,
   a few lines of Lua using `vim.uv` to splice the process's stdio to the
   socket. Neovim as its own relay means no `socat` and no OpenSSH
   stream-local forwarding (which some servers disable); the same client code
   speaks msgpack over the relay's stdio instead of a local socket. The
   lifecycle is unchanged: connection closed = server gone; `$TMUX_PANE`
   adoption; panes checked against the host's marked panes.

### Phase 3: dev containers

The same bundle and config, copied with `docker cp` into the container's
`~/.devhub-server/` (the container's own user's home), and run with `docker
exec`. tmux runs inside the container — the Workspace's `ws-` session lives
there, because that is where the folder and its tools are. The relay is the
same Lua, spawned by `docker exec -i`. A container rebuilt from its definition
loses the copy, and the next attach terraforms it again (the hash makes it a
copy, not a download).

### Order

1. Local (this phase): the mode, the editor area, the managed Neovim, routing.
2. SSH: Neovim bundle + config terraforming + relay; the not-supported state
   becomes the editor terminal for SSH Workspaces.
3. Dev containers: `docker cp` / `docker exec` for the same pieces.

## Open questions

- **Old glibc / musl hosts.** Is the official Neovim tarball enough (glibc
  2.31+), or does DevHub build a static musl Neovim like its tmux? The
  Synology case that motivated static tmux says the latter, eventually.
- **Plugins offline.** Bootstrapping lazy.nvim on a host with no route to
  GitHub fails. Should terraforming also copy the local plugin tree
  (`~/.local/share/nvim/lazy`), which is pure Lua for this person's setup?
- **Selections.** A link with a range puts the cursor at its start. Should it
  select the range in Visual mode instead?
- **Several clients.** Two clients attached to one `ws-` session share its
  current window, so selecting the Neovim window for a jump also moves any
  other client (a `tmux attach` the person runs in Terminal.app). Acceptable,
  or should the editor area use a grouped session?
- **`devhub --wait` and `:wq`.** `:wq` in the managed Neovim ends the server
  (and the marker with it), and the next jump opens a new window. Should a
  `--wait` jump instead open its buffer in a *new* Neovim that ends with it,
  the way `git commit`'s editor usually does?
- **The activity mark.** A Workspace's row shows "working" while a non-shell
  program in its session prints, and Neovim redrawing as the person types is
  that. Should an editor (`nvim`, `vim`) in front of a pane count as a prompt
  rather than as work?
- **The setting's name.** `general.workbench` names what is chosen (whether a
  workbench exists). If a third mode ever appears this stays right; an
  `editor = …` would not.
