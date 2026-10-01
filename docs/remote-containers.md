# Dev Container development

A Workspace is its folder: a folder on this Mac, or a folder on an SSH host.
Its **editor** can be attached to one of that folder's Dev Containers — the
workbench's extension host, its language servers, its tasks and its debugger
then run in the container — while everything else DevHub runs for the
Workspace stays where the folder is: its terminals, its Agents (TUI and GUI)
and its git.

So "this folder" and "this folder opened in its dev container" are **one
Workspace**, not two. The container is a mode of the editor, switched from the
editor with the same three commands VS Code has: **Reopen in Container**,
**Reopen Folder Locally** and **Switch Container**.

The transport underneath is the sibling of [SSH remote
development](remote-ssh.md): the remote extension host, the token file and the
reconnect behaviour are that document's. What follows is what differs.

## The model

`WorkspaceLocation` is `local` or `ssh`, and nothing else. Where the editor is
attached is `EditorAttachment` on the Workspace:

```ts
type EditorAttachment =
  | { kind: "host" } // the Workspace's own machine
  | { kind: "devContainer"; configPath: DevContainerConfigPath };
```

`configPath` is the chosen `devcontainer.json` on the Workspace's machine —
`<folder>/.devcontainer/devcontainer.json`, `<folder>/.devcontainer.json`, or
one of `<folder>/.devcontainer/<name>/devcontainer.json`. It is always said,
because a folder can have several definitions and each is a different
container; `devcontainer up` is always run with `--config`.

A container is addressed by `ContainerTarget` — the Workspace's location
(which machine, which folder) and the definition — and never by its container
id, which changes on every rebuild. `@devcontainers/cli` finds its own
containers by the labels `devcontainer.local_folder` and
`devcontainer.config_file`, and so does DevHub: one `docker ps` with both
filters.

Everything that is about the Workspace reads the location, and nothing reads
the attachment except the workbench's open and the commands that change it.
`locationKey` is the folder's, so a window attached to a container is filed
under the same key as one on the folder, and a reattached editor lands in the
same slot.

## Where things run

| | runs on |
| --- | --- |
| the workbench's remote extension host, extensions, language servers | the container |
| tasks and the debugger (the automation shell) | the container |
| the editor's DevHub terminal | the Workspace's machine — see below |
| DevHub terminals, the tmux server behind them | the Workspace's machine |
| Agents, TUI and GUI | the Workspace's machine |
| git, worktrees, branch and pull request rows | the Workspace's machine |
| `docker` and `devcontainer` | the Workspace's machine |
| the `devhub` command inside the container | the container, reaching DevHub through a relay |

A container is not a `Runtime`. `ContainerHost` (`main/runtime/container.ts`)
shells into it for the half that is about shells — `$HOME`, the server
install, the `devhub` command — and refuses a pty, a stream, tmux and an
Agent's program lookup as the bug they would be: something of the
Workspace's routed to its editor's far end.

### The editor's terminal

An attached window keeps a DevHub terminal, and it is the Workspace's own tmux
session — the direction VS Code calls "Create New Integrated Terminal
(Local)". Patch 0003 gives the window configuration one field,
`devhubTerminalLocal { cwd, args }`: when it is set, a terminal created with
the `devhub` profile is created with a `file:` cwd on this Mac, which is what
puts it on the local backend, and the launcher is this Mac's with
`--workspace <locationKey>`. `terminal-profile` then answers with that
Workspace's session through `Runtime.commandFromHere`: the session's own
command for a folder on this Mac, and `ssh -tt <host> -- <command>` for one on
a host.

Only the `devhub` profile moves, and the rule is one line: **the `devhub`
terminal runs on the Workspace's machine; every other profile runs in the
container.** `devhub` is the default unless the person set
`terminal.integrated.defaultProfile.linux` themselves (see "The profile is
`devhub`" in `remote-ssh.md`), so with nothing set Ctrl+`, the `+` button and
New Terminal create the DevHub terminal on the Workspace's machine, and
`devhub` picked from the list does at any time. `bash`, `sh` or any other
profile chosen from the profile list (Create New Terminal (With Profile), the
`+` button's menu) — or set as the default — is a terminal on the container's
remote pty host, as in any Dev Containers window, and the list shows the
container's own shells after `devhub`. Tasks, the debugger and a terminal an
extension makes for itself (Code Runner's) stay with the container too, as a
plain container shell: neither the automation path nor an extension's terminal
ever resolves to the DevHub launcher (patch 0003, see `remote-ssh.md`). Create
New Integrated Terminal (Local) is the DevHub terminal as well while `devhub`
is the default: it asks for this Mac by a `file:` cwd and no profile, and on
this Mac the terminal is the Workspace's tmux session, not a bare login shell
beside it. With another default chosen it is upstream's, a login shell on this
Mac.

**Where the container's half of the list comes from.** The profile list is
`devhub` followed by whatever the window's own terminal backend detects, and
in an attached window that backend is the container's server: the renderer
asks the remote pty host (`RemoteTerminalBackend.getProfiles`, answered by
the server's `remoteTerminalChannel` with upstream's detection —
`terminal.integrated.profiles.linux` checked against the container's `PATH`,
plus `/etc/shells`), and an extension's `contributes.terminal.profiles` (the
JavaScript Debug Terminal) comes from the remote extension host. Patch 0003
does not wait on, filter or replace that answer; it only puts `devhub` in
front of it and leaves out a profile named `devhub` or one that runs this
Mac's launcher, which no container shell does. So a list holding `devhub`
*alone* — not even `sh` or a contributed profile — is a window whose server
never answered: no server for the container's platform in this DevHub (a
source run without `scripts/build_reh.py`; see "A source run uses servers
built in the checkout" in `remote-ssh.md`) or a connection that did not come
up. `devhub` is still there because it needs no detection. Look at the
remote indicator and the Dev Containers output, not at the terminal
settings.

A terminal that cannot start stays open with the reason written in it until a
key closes it (patch 0003). Upstream closes it at once and says why in a
notification that times out, which read as a terminal that opened for an
instant and crashed.

The container's shells start in the folder as the container has it:
`read-configuration`'s `workspace.workspaceFolder`, the CLI's own answer
(`ContainerHost.workspacePath`). A folder inside a git repository is mounted
through the repository's root (`/workspaces/<repo>/<sub>`), so
`/workspaces/<folder name>` — what DevHub used to assume — was a folder that
did not exist, and every container terminal failed to start in it.

### `devhub` inside the container

Installed when the attached window opens, the way it is installed on any
machine DevHub shells into, and reaching DevHub through the control-socket
relay below. There is no DevHub tmux in the container to put it on a pane's
`PATH`, so the remote extension host is started with its directory in front
of `PATH`, and the tasks and terminals the server starts inherit it (in a
server-started terminal, VS Code's own `remote-cli` is in front of it and
also opens files in the window). A `devhub <file>` from inside the container
names the container as its machine, and the file opens in the window attached
to it.

It needs the container's remote extension host, whose `node` runs the relay,
so a container with no server for its platform — a source run that has not
built one into `dist/reh`, see
[remote-ssh.md](remote-ssh.md#a-source-run-uses-servers-built-in-the-checkout) —
has no working `devhub` in there. That is said once, as itself: "The devhub
command does not work inside this dev container." (`dev_container_command_unavailable`),
with the runtime's reason as the detail. It is not "This window has no DevHub
terminal", which it used to be: the window's DevHub terminal is this Mac's
launcher (see above), installed and asked for without the container, and it
works. The missing server is the window's connection's own failure too, and
that one says which `scripts/build_reh.py <target>` builds it.

## The commands

`extensions/devhub-remote` contributes **Reopen in Container**, **Reopen
Folder Locally**, **Switch Container** and **Show Build Log** to the command
palette and to the remote indicator's menu. It is `ui`-kind, so it runs on this Mac in every
window, local or attached, next to DevHub's control socket. It asks DevHub
two things with the window's folder URI, which `editorPlaceFromWorkspaceUri`
turns into its Workspace:

- `dev-container-configs` — the folder's definitions and the one the editor
  is in. Asked when the extension starts, to set `devhub.devContainerConfigs`
  for the `when` clauses, and again when a command runs. There is no file
  watcher.
- `reattach-editor` — move the editor. DevHub brings the container up first
  (building it if it has to: a person asked), closes the workbench the way a
  Workspace close does — VS Code's own unsaved-work question included, whose
  Cancel changes nothing — records the attachment, and opens the workbench
  again on the new authority.

- `dev-container-build-log` — where the build log of one of the folder's
  definitions is (see [The build log](#the-build-log)).

VS Code's own **Close Remote Connection** is not in a DevHub workbench (patch
0006): upstream it reopens the window empty and local, and DevHub has no empty
window — the request became Scratch, and the editor stayed where it was. The
way out of a container is Reopen Folder Locally, in the same menu; an SSH
Workspace *is* its host and is closed from the sidebar.

Patch 0005 decides "this is DevHub's workbench" by the product's `hostCommit`,
which every DevHub build states. An earlier version of that patch had decided it by the window's
DevHub terminal launcher, and a window whose launcher could not be installed
has none: that window got Close Remote Connection back, in the palette, the
File menu and the remote menu beside Reopen Folder Locally, and choosing it
was the Scratch switch the patch was written to remove. Behind both, DevHub
main answers an empty window asked for *in place of* a workbench attached to
a dev container (`windowToUse`, with no files) as Reopen Folder Locally of
that Workspace (`AppController.reopenLocallyInsteadOfEmpty`), not as Scratch —
so upstream's way out, from wherever it is still reached, ends where DevHub's
does.

These commands are the only way into a container. Opening a Workspace never
asks about one: a folder always opens with its editor on its own machine, and
the editor is moved from inside it. Outside the editor, the context menu of a
row whose editor is in a container has the two ways on when that editor
cannot open: **Reopen Editor in Container**, which builds the container if it
was never built (or was removed) and opens the editor in it, and **Reopen
Editor Locally**. Either is a person asking for the editor again, so a
Workspace DevHub had stopped restarting the workbench of
(`editor_restart_exhausted`) is available again — that verdict was about the
workbench it had, and leaving it standing kept the Workspace unavailable, so
the editor just reopened was taken down again at once.

The row keeps its folder's mark and wears a quiet crate mark beside its other
marks; its facts say `editor in dev container`, and the definition's name
when the folder has several.

## The build log

Every `devcontainer up` DevHub runs writes what the CLI says — the pull, the
build, the lifecycle commands — to one file per container on this Mac,
`<user data>/devhub/dev-container-logs/<hash of the container id>.log`, as it
says it (`main/runtime/buildLog.ts`). A container on an SSH host is no
different: the CLI runs there, and its output comes back over ssh as it is
written. Each bring-up replaces the file with a new one, headed by the command
and ending with how it exited.

Reopen in Container and Switch Container follow it into the window's **Dev
Containers** output while DevHub works; a container that only has to be
started or adopted writes nothing, and the output then shows nothing rather
than the last build. A bring-up that fails says so in a notice with **Show
Build Log**, and the refusal names the file too — it is also what a window
that failed to resolve says. **Dev Containers: Show Build Log** shows it at
any time: the log of the container the editor is in, or, in a window on the
folder's own machine, of the definition chosen.

## Lifecycle

### Starting: only when a person asks, and only starting when a window opens

`devcontainer up` may build an image, so it runs only on an explicit act: a
reattach from the editor's commands. Restoring an attached editor at launch, a
workbench rebuilt by the supervisor, and the resolver's first attempt only
*start* a container that exists (`ContainerHost.prepare`); one that was never
built refuses with the command that builds it, and the row's Reopen Editor in
Container (which builds it) and Reopen Editor Locally are the ways on. Nothing
on a timer reaches `up`.

### Stopping: the definition's `shutdownAction`, for a container DevHub started

The spec (containers.dev, `devcontainer.json` reference) says `shutdownAction`
is `none`, `stopContainer` or `stopCompose`, defaulting to `stopContainer` for
an image or Dockerfile definition and `stopCompose` for a Docker Compose one,
and that it says whether tools stop the containers "when the related tool
window is closed / shut down". It says nothing about a container that was
already running when the tool attached. DevHub's rule fills that in:

- A container **DevHub started** — it was absent or stopped when DevHub's own
  bring-up ran — is stopped the way its definition says when the editor
  leaves it: Reopen Folder Locally, Switch Container, or the Workspace
  closed. `stopContainer` is `docker stop <id>`; `stopCompose` is `docker
  compose --project-name <p> stop` with the project read from the container's
  `com.docker.compose.project` label; `none` leaves it.
- A container DevHub **found running** is left running, whatever the
  definition says.
- Which container DevHub started is remembered by id on the Workspace's
  persisted attachment (`started_container_id`), so a DevHub restart in
  between does not turn it into one DevHub "found". A container rebuilt since
  has another id and is left alone.
- `shutdownAction` is read with `devcontainer read-configuration`, because the
  default depends on the kind of definition.
- A stop that fails is its own notice (`dev_container_not_stopped`); the
  editor has moved anyway. Quitting DevHub stops nothing: the attachment is
  restored at the next launch.

### A stopped container, a stopped daemon, a rebuild

A container that stops under an open window takes its server with it; the
window's resolver retries, and `prepare` starts the container again on the
window's next open. `docker start` brings back a stale socket and pid file,
which the server start sweeps: the socket is asked whether it still accepts,
because a container's pids are small and reused. The workbench's existing
connection cannot be recovered — reconnection is to one server process, and it
is gone — so the window has to be reloaded, as for an SSH host whose server was
killed.

A rebuild (`devcontainer up --remove-existing-container`) produces a new
container id. The `ContainerHost` notices the id changed and refuses
everything from then on, because its caches describe a filesystem that has
been deleted; `containerHostFor` throws it away and builds another. The
Workspace is untouched: the target is still the same target.

A bring-up that itself made the new container — Reopen Editor in Container
after the old one was removed — is answered with it rather than refused: the
host is marked replaced, and the next one adopts the new container.

A new container has none of the extensions the old one had installed, until
they are installed again. The activity bar keeps an item whose extension is
away hidden rather than removed (patch 0006), as upstream already does for one
that is missing when a window opens, so an item a person had hidden stays
hidden when its extension comes back. Removing it — upstream's answer when an
extension goes away under an open window — dropped it from the list every
workbench shares, pin and all, and it came back shown.

## The transport

### `ContainerMachine`: where `docker` runs

`docker` and `devcontainer` run on the Workspace's machine. On this Mac they
are the product's (`dockerPath`, `devcontainerPath`, else `PATH`); on a host
they are found on the host's login `PATH` and run over its ssh master
(`hostContainerMachine`). The registry is the one place that chooses, from the
target's location, and nothing above the transport differs.

### Inbound: the extension host's socket, as a local port

Docker has no port forward, and a container's published ports are fixed when
it is created — the `devcontainer.json`'s business, not DevHub's. So DevHub
writes the forward itself: a TCP listener on `127.0.0.1`, and every accepted
connection gets a `docker exec -i` of its own (`ssh … docker exec -i` for a
container on a host) running a small relay against the server's unix socket
in the container. The resolver then answers `ResolvedAuthority("127.0.0.1",
<port>, <token>)`, the same answer the SSH path gives. Loopback and never
`0.0.0.0`: the connection token is the only thing between that port and an
extension host.

### Outbound: DevHub's control socket, inside the container

One long-lived `docker exec` runs the same relay in `listen` mode on a socket
in the container, and every connection it accepts is carried back over that
exec's stdio to DevHub's real socket here, framed `[id, length]` because one
exec carries many connections. That is what the `devhub` command in the
container talks to.

### Why node, and which node

The relay runs on the remote extension host's own `node`,
`~/.devhub-server/bin/<key>/node` — not `socat` and not a system `node`,
which few dev container images have. So the server is installed before the
relay is written, stated in `#relayPaths`: the `devhub` command is installed
when a window opens, before that window has resolved.

**The server comes out of DevHub; the container receives it.** DevHub carries
its servers inside the app — glibc and musl Linux, x64 and arm64 — and the one
the container needs is unpacked there from a stream on `docker exec -i` stdin,
after DevHub has asked the container's C library: an Alpine-based image gets
the musl server, a Debian- or Ubuntu-based one the glibc server. A container's
egress is whatever its image and the person's Docker allow, and DevHub needs
none of it: a container started with `--network none` gets a server that
starts and answers like any other, `libstdc++` included for Alpine. See
[The servers travel inside DevHub](remote-ssh.md#the-servers-travel-inside-devhub).

**Verified against real containers, offline.**
`main/runtime/rehInstall.docker.test.ts` starts containers with `--network
none` and the labels `devcontainer up` would give them, has `ContainerHost`
adopt them, install the server out of a bundle directory and start it, and asks
the server `/version` through DevHub's own bridge. It needs Docker and a
`dist/reh`, so it runs only when asked:

```sh
DEVHUB_REH_BUNDLE=$PWD/dist/reh DEVHUB_REH_IMAGES="debian:bookworm-slim alpine:3.20" \
  npx vitest run src/main/runtime/rehInstall.docker.test.ts   # in apps/desktop
```

## The authority

`dev-container+<hex>`, where the hex is `{"hostPath", "configPath", "sshHost"?}`
as UTF-8 JSON, composed by `editorAuthorityOf` and read back by
`decodeContainerAuthority`, one place each. It carries the definition because
two definitions of one folder are two different editors of one Workspace, and
the resolver has to know which container to reach. It never carries the
container id. Hex rather than base64url because an authority is
case-insensitive in some hands. An authority without a `configPath` — written
by a DevHub before this — is one this DevHub did not write, and names nothing.

The resolver passes the payload through as `container:<hex>`, the
`ContainerHostId` that `ContainerHost`s are filed under; the `devhub` command
in the container says it is asking from the same id.

## Migration from state version 11

Before version 12 a Dev Container Workspace was its own location,
`container:<host folder>`, whose terminals and Agents ran in the container.
Version 12 turns each into the local Workspace of its host folder with its
editor attached:

- The definition a version-11 file did not record is read before the
  migration runs (`containerMigration.ts`): from the container's
  `devcontainer.config_file` label, or, with no container, the CLI's own
  default order in the folder. Docker not answering is said; no definition at
  all opens the editor on this Mac and says so. Nothing is guessed.
- A folder that was open both ways becomes one Workspace: the local record
  stays and everything that named the other — the selection, the sidebar
  order — is pointed at it.
- The Agents of a container Workspace ran inside the container, where DevHub
  runs no Agents now; they are removed.
- A `container:` entry in `session_machines` is dropped.

What changed is said in one notice (`state_migrated`).

## Requirements

- **Docker** where the Workspace's folder is: Docker Desktop, Rancher
  Desktop, colima on this Mac; any `docker` on the host's login `PATH` on a
  host.
- **The `devcontainer` CLI**, `@devcontainers/cli`, in the same place.
- **A Linux container**, on x64 or arm64, with glibc or musl — the four
  platforms DevHub carries a server for. Anything else is refused by name.
  The container needs no network access.
- **A packaged DevHub, or a source run started by
  `apps/desktop/scripts/dev.sh`** whose `dist/reh` holds the server the
  container needs, built by `scripts/build_reh.py` from the checkout — see [a
  source run uses servers built in the
  checkout](remote-ssh.md#a-source-run-uses-servers-built-in-the-checkout).

  It used not to: DevHub read `commit` alone, so a source run's Reopen in
  Container opened a window whose resolver was refused ("states no commit …
  SSH workspaces need a packaged build"), and the first thing that reached
  for the container after that — Open Settings, which reads the remote
  settings file — failed as "Unable to open 'Settings'" with the same
  sentence. The window had never connected; the dialog was only where it
  showed.

## Where to look when it does not connect

1. **`docker ps -a --filter label=devcontainer.local_folder=<folder>
   --filter label=devcontainer.config_file=<definition>`** — the exact
   question DevHub asks (on the host, for an SSH Workspace).
2. **The build log** (Dev Containers: Show Build Log), or
   **`devcontainer up --workspace-folder <folder> --config <definition>`** by
   hand; its log is on stderr and its one JSON object on stdout.
3. **The server's log, in the container:**
   `docker exec <id> cat ~/.devhub-server/.<key>.log`, where `<key>` is
   `<commit>-<identity>` — `ls ~/.devhub-server/bin/` in the container shows
   it.
4. **The relay:** `docker exec <id> ls -l ~/.devhub-server/relay.cjs`.
5. **The extension host log** in the window. `CANNOT use API proposal:
   resolvers.` means the `product.json` grant for `devhub.devhub-remote` did
   not apply.

## The checklist

1. Open a folder with two definitions (`.devcontainer/devcontainer.json` and
   `.devcontainer/<name>/devcontainer.json`). The palette offers **Reopen in
   Container** and asks which; the Dev Containers output shows the build as
   it runs, and a definition that does not build offers Show Build Log.
2. The window comes up with `Dev Container: <folder>` (and the definition's
   name) in the status bar; the explorer shows the bind-mounted folder.
3. Ctrl+` (with no `terminal.integrated.defaultProfile.linux` set): the
   terminal is `tmux - Local` with the tmux icon and attached to the
   Workspace's own session on the Workspace's machine
   (`tmux -L <socket> list-clients`); the `+` menu lists `devhub` first, as
   the default. Set `defaultProfile.linux` to `bash`: Ctrl+` is a container
   shell, and `devhub` from the `+` menu is still the Workspace's session.
   Create New Terminal (With Profile) → `bash`: a shell in the container, in
   the folder, for a folder that is a subfolder of a repository too.
4. A task runs in the container: its `hostname` is the container's.
5. `devhub <file>` from inside the container opens in this window.
6. **Switch Container** to the other definition: the new container comes up,
   and the old one, if DevHub started it, stops per its `shutdownAction`.
7. **Reopen Folder Locally**: the editor is on the folder's machine; a
   container DevHub started stops, one it found running does not.
8. Restart DevHub with the editor attached: it comes back attached, starting
   (never building) the container.
9. The row's **Reopen Editor Locally** does what 7 does.
   `docker rm -f` the container and restart DevHub: the editor cannot open
   (the container has not been built), and the row's **Reopen Editor in
   Container** builds it and opens the editor in it, as does its **Reopen
   Editor Locally** open it on the folder's machine — both from the state
   where DevHub had stopped restarting the workbench.
10. Close the Workspace: a container DevHub started stops.
11. Nothing is left behind: no stray `docker exec` or `ssh` processes.
