# DevHub

DevHub is not VS Code wrapped in Tauri. It is a workspace- and agent-centred
development environment, closer to the Codex App or the Cursor agent window,
in which a real VS Code editor is one surface among several rather than the
centre of the product.

```text
DevHub
  ├─ Workspace management
  ├─ Agent orchestration
  ├─ Editor
  ├─ Terminal
  ├─ Issue          (later)
  └─ Pull Request   (later)
```

macOS first, Apple Silicon. This is a personal tool built for one workflow,
so it optimises for that workflow rather than for configurability.

## Shape

One window. A left pane of Workspaces, each with its Agents nested under it,
and one main surface on the right.

```text
┌──────────────────────────────────────────────────────┐
│              [Editor] [Agent] [Terminal]             │
├───────────────┬──────────────────────────────────────┤
│ Scratch       │                                      │
│               │                                      │
│ ▼ foo         │            Active Surface            │
│    Claude 1 ● │                                      │
│    Codex  2 ○ │                                      │
│ ▼ bar         │                                      │
│    Claude 1 ● │                                      │
└───────────────┴──────────────────────────────────────┘
```

The top strip is a fixed set of **Activities**, not tabs: Editor, Agent,
Terminal. There is no subtitle strip and no status bar.

The left pane selects **what** you are working on; the Activity selects
**which view** of it you see:

- select a Workspace → its Editor
- select an Agent → that Agent
- Editor is per Workspace; Terminal is per Workspace; Agent is per Agent

A Workspace with no Agents shows no disclosure and no child tree at all.

Editor never appears in the left pane, because every Workspace has exactly one
and the Workspace node is its entry point.

## Domain

Workspace is the top concept, and it is deliberately none of the things it
resembles:

```text
DevHub Workspace != Herdr Space != VS Code window != Git repository
```

A Workspace is a folder root — the same granularity as a VS Code window. A
normal clone and each linked worktree are separate Workspaces. Workspaces are
transient: they are what you have open now, discovered by fuzzy-finding
configured source directories rather than kept in a registry.

Internally a Workspace knows its Git remote, so that a future "paste an issue
URL and start working" flow can resolve which checkout to open.

## Subsystems

**Editor** — a browser VS Code workbench embedded in a child WebView. One
server process serves every Workspace's editor. The workbench is upstream and
unforked. DevHub uses the VS Code you already installed rather than shipping
one, which also means it rides your own updates.

**Agents** — Herdr runs them, behind an `AgentRuntime` seam that exposes only
list/start/stop/status/read/attach. Herdr's own Space, Workspace, and Tab
concepts never reach the DevHub UI. DevHub uses a fixed `devhub-session` so a
bare `herdr` lands in your default session and cannot disturb DevHub's agents.
Herdr is expected to be replaceable later by a Claude SDK or Codex Server
runtime.

**Terminal** — tmux, not the VS Code integrated terminal and not Herdr. One
persistent session per Workspace, plus a global Scratch session. The VS Code
integrated terminal stays available inside the workbench; DevHub does not
police it.

## Lifecycle

Window Close leaves the process, the agents, and the tmux sessions running.
Quit stops DevHub and its editor server but still leaves agents and tmux
alive. Closing an Agent destroys its session; an Agent that exits on its own
disappears from the tree immediately.

`Command+Q` is the only key DevHub takes from the workbench, as a prefix:
press it twice to quit. Everything else is forwarded to VS Code.

## The `devhub` command

`DevHub: Install 'devhub' command in PATH` writes a launcher that talks to the
running app over a unix socket in its user-data directory. Everything the
command does happens inside the app: there is one instance, one extensions
directory and one editor, and a second process doing any of this behind the
first one's back is the state the single-instance design exists to prevent.

```sh
devhub <folder>                      # open it as a Workspace and show it
devhub <file>                        # open it in the Workspace that contains it
devhub -g|--goto <file:line[:col]>   # ...with the cursor there
devhub --agent <profile> [-- <args>] # start an Agent in this directory's Workspace
devhub --install-extension <id|vsix> [--force]
devhub --uninstall-extension <id> [--force]
devhub --list-extensions [--show-versions]
devhub --version                     # DevHub, VS Code, and the commit
```

Which Workspace a path lands in is decided by the path, never by which window
was focused last: the open Workspace whose root is its nearest ancestor, and
the Scratch editor when no open Workspace contains it. The extension options
are VS Code's own `ExtensionManagementCLI`, run against the running app's
extension management service, so the gallery (Open VSX), the allow-list and the
built-in protections are the ones the app itself uses. An option `devhub` does
not know is refused with a sentence — it is never quietly treated as a path.

## Configuration

One `~/.config/devhub/config.toml`, safe to symlink from dotfiles. Native
Settings edits the same file. Runtime state lives separately under
Application Support.

## Not now

Issue and Pull Request surfaces, task composer, clone/worktree provisioning,
Dev Containers, SSH, multiple windows, Windows and Linux. They are second and
third development; the seams exist, the features do not.

## Development

Rust `1.97.1`, Node `22.21.1`, pnpm `11.20.0`.

```sh
CI=true pnpm install --frozen-lockfile
pnpm dev          # run the app
pnpm run check    # format, lint, types, tests
pnpm run build
```

The Rust-owned App Shell contract is generated from the native wire types in
[`contracts/app-shell/`](contracts/app-shell/). Run `pnpm run app-shell:generate`
after changing that seam; `pnpm run check` detects drift.

DevHub is distributed under the [MIT License](LICENSE).
