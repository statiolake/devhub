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
the DevHub profile is created with a `file:` cwd on this Mac, which is what
puts it on the local backend, and the launcher is this Mac's with
`--workspace <locationKey>`. `terminal-profile` then answers with that
Workspace's session through `Runtime.commandFromHere`: the session's own
command for a folder on this Mac, and `ssh -tt <host> -- <command>` for one on
a host.

Only the DevHub profile moves. Every other profile, every task and the
debugger stay with the container, and the patch already refuses the DevHub
profile as the automation shell. From that terminal, `devcontainer exec` is
how to reach the container by hand.

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

## The commands

`extensions/devhub-remote` contributes **Reopen in Container**, **Reopen
Folder Locally** and **Switch Container** to the command palette and to the
remote indicator's menu. It is `ui`-kind, so it runs on this Mac in every
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

Outside the editor there is one way in and one way out: the workspace
picker's **Open in a Dev Container?** sheet, which offers one row per
definition, and **Reopen Editor Locally** on the context menu of a row whose
editor is in a container — the way out when that editor cannot open.

The row keeps its folder's mark and wears a quiet crate mark beside its other
marks; its facts say `editor in dev container`, and the definition's name
when the folder has several.

## Lifecycle

### Starting: only when a person asks, and only starting when a window opens

`devcontainer up` may build an image, so it runs only on an explicit act: a
reattach, or the picker's sheet. Restoring an attached editor at launch, a
workbench rebuilt by the supervisor, and the resolver's first attempt only
*start* a container that exists (`ContainerHost.prepare`); one that was never
built refuses with the command that builds it, and the row's Reopen Editor
Locally is the way out. Nothing on a timer reaches `up`.

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
`~/.devhub-server/bin/<commit>/node` — not `socat` and not a system `node`,
which few dev container images have. So the server is installed before the
relay is written, stated in `#relayPaths`: the `devhub` command is installed
when a window opens, before that window has resolved.

**This Mac fetches; the container receives.** The server tarball is fetched
here and unpacked in the container from a stream on `docker exec -i` stdin: a
container's egress is whatever its image and the person's Docker allow.

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
- **A packaged DevHub.** A source run states no `commit`, so there is no remote
  extension host to install — the same refusal as [a source run cannot
  connect](remote-ssh.md#a-source-run-cannot-connect).

## Where to look when it does not connect

1. **`docker ps -a --filter label=devcontainer.local_folder=<folder>
   --filter label=devcontainer.config_file=<definition>`** — the exact
   question DevHub asks (on the host, for an SSH Workspace).
2. **`devcontainer up --workspace-folder <folder> --config <definition>`** by
   hand; its log is on stderr and its one JSON object on stdout.
3. **The server's log, in the container:**
   `docker exec <id> cat ~/.devhub-server/.<commit>.log`.
4. **The relay:** `docker exec <id> ls -l ~/.devhub-server/relay.cjs`.
5. **The extension host log** in the window. `CANNOT use API proposal:
   resolvers.` means the `product.json` grant for `devhub.devhub-remote` did
   not apply.

## The checklist

1. Open a folder with two definitions (`.devcontainer/devcontainer.json` and
   `.devcontainer/<name>/devcontainer.json`). The palette offers **Reopen in
   Container** and asks which.
2. The window comes up with `Dev Container: <folder>` (and the definition's
   name) in the status bar; the explorer shows the bind-mounted folder.
3. Ctrl+`: the terminal is `tmux - Local` and attached to the Workspace's own
   session on the Workspace's machine (`tmux -L <socket> list-clients`).
4. A task runs in the container: its `hostname` is the container's.
5. `devhub <file>` from inside the container opens in this window.
6. **Switch Container** to the other definition: the new container comes up,
   and the old one, if DevHub started it, stops per its `shutdownAction`.
7. **Reopen Folder Locally**: the editor is on the folder's machine; a
   container DevHub started stops, one it found running does not.
8. Restart DevHub with the editor attached: it comes back attached, starting
   (never building) the container.
9. The row's **Reopen Editor Locally** does what 7 does.
10. Close the Workspace: a container DevHub started stops.
11. Nothing is left behind: no stray `docker exec` or `ssh` processes.
