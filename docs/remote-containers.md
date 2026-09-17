# Dev Container development

A Workspace can be a folder on this Mac that is opened *inside* a Dev
Container: the editor, the terminals and the Agents run in the container, and
the folder itself stays here, bind-mounted in.

This is the sibling of [SSH remote development](remote-ssh.md), and most of
that document applies unchanged — the remote extension host, the token file,
the reconnect behaviour, tmux, the `devhub` shim, the PATH rules. What follows
is only what differs. Read that one first.

## What is the same, and why that is not a coincidence

DevHub reaches a container the way it reaches a host: it runs POSIX `sh` over a
connection this Mac holds. `ContainerRuntime` and `SshRuntime` are both
`RemoteShellRuntime`, and the base class is where the login-environment probe,
the `sh`-based file operations, the git-refs digest, the terminal launcher and
the tmux install live. None of them were written twice and none of them know
which transport they are on.

So a container gets exactly what a host gets: DevHub's own static tmux
delivered into it, the terminal launcher and the `devhub` shim written into a
tagged bin directory, `DEVHUB_ORIGIN` on the tmux session, the remote extension
host installed under `~/.devhub-server/bin/<commit>` and started on a unix
socket with a token file that is the single source of truth.

**This Mac fetches; the container receives.** The same rule as SSH, for a
sharper reason: a dev container's network egress is whatever its image and the
person's Docker setup allow, and plenty have none. The remote extension host
tarball is fetched here and unpacked in there from a stream on `docker exec -i`
stdin — measured at 96 MB in 1.3 s against a local daemon.

## The transport: two relays

The one thing docker does not give DevHub is a forward, in either direction.

### Inbound: the extension host's socket, as a local port

`ssh -L` turns a socket on a host into a port on this Mac. Docker has nothing
of the kind. A container's published ports are fixed **when it is created**,
which is the `devcontainer.json`'s business and not DevHub's, and an existing
container cannot gain one without being destroyed — so publishing a port is not
available to DevHub even in principle.

So DevHub writes the forward itself. It opens a TCP listener on `127.0.0.1`,
and every connection it accepts gets a `docker exec -i` of its own running a
small relay against the server's unix socket in the container, with the exec's
two stdio streams piped to the socket. The resolver then answers
`ResolvedAuthority("127.0.0.1", <that port>, <token>)`, which is the identical
answer the SSH path gives — which is why there is one resolver extension with a
machine parameter and not two extensions.

One `docker exec` per connection sounds extravagant and is not. A workbench
opens a handful — the management connection, the extension host, one per
terminal — and against a local daemon a connection costs about **35 ms**.

Loopback and never `0.0.0.0`: the connection token is the only thing between
that port and an extension host.

### Outbound: DevHub's control socket, inside the container

There is no reverse forward either, so the control socket is relayed the same
way in the other direction. One long-lived `docker exec` runs the same relay in
`listen` mode on a socket inside the container, and every connection it accepts
is carried out over that exec's stdio and connected to DevHub's real socket
here.

That one exec has to carry many connections, so this direction is framed: each
connection gets a number and every chunk is prefixed with `[id, length]`. The
inbound direction needs none of that — it has an exec per connection.

This is what makes the `devhub` command, `--wait` and the terminal launcher
work from a pane in the container without a single line of them knowing they
are in one. Everything above the socket is exactly as `remote-ssh.md` describes
it: one control protocol, one answering side.

### Why node, and which node

The relay runs on the **remote extension host's own `node`**, at
`~/.devhub-server/bin/<commit>/node`. Not `socat`, which is in approximately no
dev container image, and not a system `node`, which many images do not have
either — the `mcr.microsoft.com/devcontainers/base:ubuntu` image has neither.
Installing a package into somebody's container to move bytes would be DevHub
changing the thing it was asked to connect to.

That makes the ordering explicit: the server install lands before anything
needs a relay.

## Where things run

| | runs on |
| --- | --- |
| the editor and its extension host | the container |
| terminals, and the tmux server behind them | the container |
| Agents | the container |
| **git, worktrees, branch and pull request rows** | **this Mac** |
| `devcontainer` and `docker` | this Mac |

Git running here is a decision, not an accident, and it lives in one function —
`gitPlaceOf` in `apps/desktop/src/model/domain.ts`. Three reasons, in order:

1. Watching a directory here is a real `fs.watch`, not the `cksum`-over-`refs`
   polling a far machine has to be asked for. That is a fidelity win, not just
   a cost one.
2. A Workspace's branch, worktrees and pull request rows are DevHub's own
   panel, and a stopped container would otherwise take all of it with it — when
   a stopped container is meant to be a *state*, not a failure.
3. The container may not have been built yet when the row is first drawn.

The rule needs no probe because of where these locations come from: DevHub
makes one out of a folder on this Mac, so the host folder is a path that exists
here by construction. `gitPlaceOf`'s return type cannot represent a container,
so a caller that ever tried to send git into one would not compile.

A `devcontainer.json` that clones into a volume rather than bind-mounting is
not something DevHub offers to open. If that changes, `gitPlaceOf` is the one
function that has to learn about it.

## Lifecycle

### Finding the container costs one `docker ps`

`@devcontainers/cli` stamps every container it creates with
`devcontainer.local_folder` and `devcontainer.config_file`, and looks its own
containers up by exactly those. So DevHub answers "is this Workspace's
container up?" with

```sh
docker ps -a --no-trunc --filter label=devcontainer.local_folder=<folder> \
  --format '{{.ID}}\t{{.State}}\t{{.Image}}'
```

`--no-trunc` is load-bearing, not tidiness. Without it `{{.ID}}` is the short
twelve-character id while `devcontainer up` answers with the full sixty-four,
so the two ways DevHub learns an id spell the same container differently — and
the comparison that decides "has this been rebuilt?" reads every restart as a
rebuild.

and never spawns the CLI on the happy path. `devcontainer up` is a 1.7 MB Node
bundle and about a second of wall clock; this poll runs every few seconds.

A container whose state is `removing` is skipped — the CLI's own lookup drops
those too, and adopting one would be adopting a filesystem that is being
deleted underneath every command sent to it.

### `devcontainer up` runs only when it must

When there is no container, when there is a stopped one, or when a running one
no longer answers. It is the only thing that knows how to build an image,
create a container and run the lifecycle commands the definition asks for, and
DevHub has no second opinion about any of that.

Its JSON is read strictly. An `outcome` DevHub does not recognise is a hard
failure that names the CLI — not something to work around. The alternative is
carrying on with a `containerId` that is actually an error message.

### A stopped container is a state, not a failure

So is a Docker daemon that is not running. Both are `MachineConditions`
episodes: raised once per episode against the machine, retracted once on
sustained recovery, with a sentence that names what was looked for. Starting
the container is an action the row offers.

### A restarted container needs the window reloaded

`docker stop` kills the server with the container, and `docker start` brings
back a filesystem with a stale socket file and a stale pid file in it. DevHub
recovers the transport by itself: the socket is asked whether it still accepts
— a connection, not a pid check, because a container's pids are small enough
that the one in the file has very likely been reused — and a socket that
refuses is swept away so the server starts fresh.

What does **not** recover is the workbench's existing connection. VS Code
reconnects with a token the *previous* server process issued, and the new one
answers `Unknown reconnection token (never seen)`. That is not something the
transport can fix: reconnection is between a client and one server process, and
that process is gone. The window has to be reloaded.

The same is true of an SSH host whose server is killed. It is worth knowing
here because stopping a container is a thing people do casually.

### A rebuild replaces the machine underneath the Workspace

This is the sharp edge, and it is worth understanding.

A Workspace's **machine id is the host folder** — `container:/src/api` — and
never the container id. Rebuilding is routine; it is what dev containers are
*for*. A machine id that carried the container id would make every rebuild a
brand-new machine, and `locationKey` keys the Workspace on the host folder for
the same reason: a rebuild must not cost a person their row, its Agents and its
history.

But a rebuilt container is a new filesystem with none of what DevHub installed,
and every "installed once per machine" cache in the base class — tmux, the
launcher, the server — is keyed on the *runtime instance*. So when the runtime
sees a container id that is not the one it has been talking to, it throws at
that moment and refuses everything afterwards; `disposeRuntime` throws the
instance away and the next call builds a fresh one.

It throws at the moment it notices rather than on the next call, deliberately.
A runtime that answered one more command would answer it against a container
that has none of what it believes it installed, and the failure that produced
would surface later and somewhere else — as a missing tmux, or a launcher that
is not there.

## The authority

`dev-container+<hex>`, where the hex is `{"hostPath": "<folder on this Mac>"}`
as UTF-8 bytes.

Composed by `remoteAuthorityOf` and read by `locationFromWorkspaceUri`, both in
one place each, so the URI a window is opened with and the authority the
resolver is asked to resolve cannot drift apart.

Two things it deliberately does **not** carry:

- **The container id**, because the authority is a window's identity and a
  rebuilt container must not change it.
- **`configPath`**, because it is not part of `locationKey` either — an
  authority that carried it would be a second identity for one Workspace, and
  the two would disagree the moment somebody set one.

Hex rather than base64url because a URI authority is case-insensitive in some
hands and base64 is not.

The name `dev-container` is the one Microsoft's closed extension uses, and
DevHub uses it too — not for compatibility, since nothing is exchanged with it
and the payload above is DevHub's own shape, but because it is the word
everything written about dev containers uses.

## Requirements

- **Docker on this Mac.** Docker Desktop, Rancher Desktop, colima — anything
  whose `docker` CLI talks to a local daemon. A *remote* docker context is not
  supported: the cadence here assumes a daemon microseconds away, and a
  container across a network would need the round-trip arithmetic `ssh.ts` has.
- **The `devcontainer` CLI**, `@devcontainers/cli`. `npm i -g
  @devcontainers/cli`, or Homebrew's `devcontainer`.
- **A packaged DevHub.** A source run states no `commit`, so there is no remote
  extension host to install or ask for — the same refusal, in the same words,
  as [a source run cannot connect](remote-ssh.md#a-source-run-cannot-connect).

Both binaries are found on `PATH` unless `product.json` states `dockerPath` or
`devcontainerPath`. They are named separately because they are separately
absent: a Mac can have Docker and no `devcontainer` CLI, and the two refusals
name different things to install.

## Where to look when it does not connect

In order, because each answers a different question:

1. **`docker ps -a --filter label=devcontainer.local_folder=<folder>`** — is
   there a container, and is it running? This is the exact question DevHub
   asks.
2. **`devcontainer up --workspace-folder <folder>`** by hand. Its log goes to
   stderr and its one JSON object to stdout, so the failure is usually legible
   there before it is anywhere else.
3. **The server's own log, in the container:**
   `docker exec <id> cat ~/.devhub-server/.<commit>.log`. "Extension host agent
   listening on …" means the server is up and the problem is the transport.
4. **The relay.** `docker exec <id> ls -l ~/.devhub-server/relay.cjs` — it is
   written by DevHub on every connect. If the server is listening and the
   workbench is not connecting, this is the half to suspect.
5. **The extension host log** in the window (`Developer: Open Extension Host
   Log`). `CANNOT use API proposal: resolvers.` means the `product.json` grant
   for `devhub.devhub-remote` did not apply — see
   [remote-ssh.md](remote-ssh.md#why-devhub-resolves-its-own-authorities).

## The checklist

What a change to any of this has to be walked through, the sibling of the
eleven-step list in `remote-ssh.md`:

1. Open a folder with a `.devcontainer/` as a Dev Container Workspace. The
   window comes up with `Dev Container: <folder>` in the status bar.
2. The integrated terminal is DevHub's tmux, running **in the container**:
   `hostname` is the container's, and the workspace folder is the path inside.
3. `devhub --version` works from a pane — that is the control-socket relay.
4. `devhub --wait <file>` blocks and returns when the tab is closed.
5. An Agent starts, and runs in the container.
6. Git, the branch and the worktree rows are correct — and they are **this
   Mac's** git, against the host folder.
7. Stop the container (`docker stop <id>`). A machine condition appears saying
   so; the Workspace's git keeps working.
8. Start it again. The condition retracts, the server is restarted inside the
   container, and the terminals come back — the window itself needs reloading,
   for the reason above.
9. Rebuild it (`devcontainer up --remove-existing-container`). The Workspace
   survives with its row and its history; the runtime is replaced.
10. Close the lid, open it. The workbench reconnects without restarting the
    extension host.
11. Nothing is left behind: no stray `docker exec` processes, no tmux server
    outside the container.
