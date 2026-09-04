# DevHub

DevHub is a workspace- and agent-centred development environment for macOS, in
which a real VS Code editor is one surface among several rather than the centre
of the product. It ships that editor: VS Code's own desktop workbench, built
from a pinned submodule, running inside DevHub's window.

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
┌───────────────┬───────────────────────┬──────────────┐
│           [▥] │                       │              │
│ Scratch       │                       │              │
│               │                       │              │
│ ▼ foo         │       Workbench       │  Agent pane  │
│    Claude 1 ● │                       │              │
│    Codex  2 ○ │                       │              │
│ ▼ bar         │                       │              │
│    Claude 1 ● │                       │              │
└───────────────┴───────────────────────┴──────────────┘
```

There is no title bar, no activity switcher, no subtitle strip and no status
bar. A Workspace **is** its workbench, full width and full height; the sidebar
is what the window is dragged by, and the one control on it collapses the
sidebar to an icon rail.

The left pane selects what you are working on, and that is the whole selection:

- select a Workspace → its workbench
- select an Agent → that same workbench, with the Agent's pane beside it on a
  divider you can drag; the ratio is remembered
- there is no separate Terminal: a terminal is the workbench's own integrated
  terminal, attached to the tmux session DevHub keeps for that context, so it
  survives quitting the app exactly as it always did

A Workspace with no Agents shows no disclosure and no child tree at all.

The workbench never appears in the left pane, because every Workspace has
exactly one and the Workspace node is its entry point.

## Domain

Workspace is the top concept, and it is deliberately none of the things it
resembles:

```text
DevHub Workspace != VS Code window != Git repository
```

A Workspace is a folder root — the same granularity as a VS Code window. A
normal clone and each linked worktree are separate Workspaces. Workspaces are
transient: they are what you have open now, discovered by fuzzy-finding
configured source directories rather than kept in a registry.

Internally a Workspace knows its Git remote, so that a future "paste an issue
URL and start working" flow can resolve which checkout to open.

## Subsystems

**Editor** — VS Code's desktop workbench, from the pinned `vscode/` submodule,
built and shipped with DevHub. Each Workspace's workbench is one VS Code window
in every sense the workbench itself can observe, laid into DevHub's single
window as a `WebContentsView`. Extensions, settings, the integrated terminal
and the extension host are the real ones, on disk, with no "remote" semantics
anywhere.

**Agents** — an Agent is a tmux session, with no runtime in between. It lives
on DevHub's own tmux socket, carries DevHub's own markers, and is attached by
the same `tmux attach-session` over the same PTY as every Workspace terminal,
so scrollback, copy mode, resize and byte-for-byte input are the terminal's
rather than an imitation of one. See
[`src/main/agent/sessions.ts`](apps/desktop/src/main/agent/sessions.ts).

**Terminal** — tmux. One persistent session per Workspace, plus a global
Scratch session. The workbench's own integrated terminal is attached to that
same session, so quitting DevHub does not end it.

## Architecture

VS Code is **consumed, never edited**. The whole of the integration is three
kinds of thing, and each has a rule:

- **Two entry points, copied.** `apps/desktop/src/main/main.ts` and
  `codeMain.ts` are adapted copies of upstream's `src/main.ts` and
  `src/vs/code/electron-main/main.ts`. Each carries a header listing every
  substitution it makes, so a VS Code bump is "re-apply exactly this list"
  rather than a diff nobody can read.
- **Composition, everywhere else.** DevHub subclasses and registers VS Code's
  own main-process services (`src/main/services/`), replaces the `BrowserWindow`
  constructor VS Code reaches for, and fences the process-wide `electron.app`
  calls a workbench is not entitled to make
  ([`shell/appFence.ts`](apps/desktop/src/main/shell/appFence.ts)).
- **Patches, only for what none of that can reach.**
  [`patches/vscode/`](patches/vscode) is the exception, and every patch states
  its own reason in its body. There are two.

DevHub's own integration ships as a built-in extension,
[`extensions/devhub-bridge`](extensions/devhub-bridge), so that its workbench
defaults are in effect and cannot be uninstalled. The narrow protocol between
them is schema-checked: see [`contracts/bridge/`](contracts/bridge).

## Lifecycle

Window Close leaves the process, the agents and the tmux sessions running.
Quit stops DevHub but still leaves agents and tmux alive. Closing an Agent
destroys its session; an Agent that exits on its own disappears from the tree
immediately.

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
devhub -                             # open what is piped in, the way 'code -' does
devhub -w|--wait <file>              # ...and wait for its editor to close
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

Two files in `~/.config/devhub/` (or `$XDG_CONFIG_HOME/devhub/`), read as one.
`settings.toml` is the shared half — meant to be a symlink from dotfiles, and
never written by DevHub. `settings.local.toml` is what is only true of this
machine, and the only file a save touches: Settings edits there, writing down
just what the shared file does not already say.

Tables merge key by key, so the shared file can hold `[appearance]` while a
machine overrides nothing but the font; everything else, arrays included, the
local file replaces whole. A pre-split `config.toml` is renamed to
`settings.local.toml` on first launch.

The workbench's own settings are VS Code's, on disk under the app's user-data
directory. Runtime state lives separately under Application Support.

## Not now

Issue and Pull Request surfaces, task composer, clone/worktree provisioning,
Dev Containers, SSH, multiple windows, Windows and Linux. They are second and
third development; the seams exist, the features do not.

## Development

pnpm `11.20.0`. The Node the VS Code build requires is fetched into a
gitignored toolchain directory by provisioning; the machine default is not
used for it.

```sh
CI=true pnpm install --frozen-lockfile
pnpm run provision   # submodule, toolchain, patches, compile, Electron
pnpm dev             # build apps/desktop and run it
pnpm run check       # bridge contract, format, lint, types, tests
```

Provisioning is idempotent and stamped over the submodule commit *and* the
patches, so a bump or a patch edit recompiles and nothing else does. `--force`
redoes every step.

`pnpm dev` runs under the `dev` profile, so a source build and the packaged
DevHub can be open at the same time — which is what makes developing DevHub
inside DevHub possible. `DEVHUB_PROFILE` is the whole switch: unset (every
packaged run) is the default profile, on exactly the locations DevHub has
always used, and any other name derives a complete, disjoint set of them —
`~/Library/Application Support/DevHub Dev/` for the editor's user data and
extensions, `~/.config/devhub-dev/` for the settings, the `devhub-dev` tmux
socket, its own control socket, and a `devhub-dev` command in the PATH.
`src/model/profile.ts` derives all of it from the one name.

A new profile's first launch copies the default profile's
`settings.local.toml` in, so it starts configured rather than empty, and says
so in the log. It is a copy: the two are meant to drift. `settings.toml` is not
copied — it is the shared half, and both profiles pointing at the same dotfiles
symlink is right. One setting a profile does not take from that copy is
`runtimes.tmux_socket_name`: a second DevHub on the first one's tmux server
would manage the first one's sessions, so the profile's socket wins and the
override is logged.

## Building the app

```sh
pnpm build
```

From a fresh clone that is the whole procedure: it installs the workspace,
provisions the VS Code submodule (checkout, the Node the submodule's build
pins, `npm ci`, DevHub's patches, both compiles, Electron) and assembles

```text
dist/DevHub.app
dist/DevHub-darwin-arm64-<date>-<sha>.zip
```

signed ad-hoc — enough for macOS to run a modified bundle, not enough to skip
`xattr -d com.apple.quarantine` on a bundle that has travelled. The build does
not start what it just made: a running DevHub takes over the machine's tmux
socket and its Agents, and nobody asks for that by typing `pnpm build`. The
check that a bundle which assembles can also run is `pnpm run smoke`
(`scripts/smoke_packaged_app.py dist/DevHub.app`), which starts the bundle
under a throwaway `smoke` profile and asks it something over its control
socket. CI runs it on every bundle it packages.

What has to be on the machine first: macOS on Apple Silicon, the Xcode command
line tools (`xcode-select --install`), `python3`, Node, and pnpm `11.20.0`
(`corepack enable && corepack prepare pnpm@11.20.0 --activate`). The machine's
own Node version does not matter — the one VS Code's build insists on is
fetched into `vscode-toolchain/`. Anything else missing, `pnpm build` produces
rather than complains about.

The first build is roughly **40–60 minutes**, nearly all of it VS Code's `npm
ci` and its two compiles. Those are stamped, so a later build that changes only
DevHub's own code is **about a minute**, and a submodule bump or a patch edit
puts the long part back.

The nightly workflow runs this same `pnpm build`; what it adds is a cache of
the provisioned submodule, and publishing the zip.

DevHub's product identity is stated once, in
[`apps/desktop/product-overrides.json`](apps/desktop/product-overrides.json),
and merged into `product.json` by
[`scripts/product_metadata.py`](scripts/product_metadata.py) for both the source
run and the packaged app.

The bridge protocol's checked-in artifacts are generated: run
`pnpm run bridge:generate` after changing that seam, and `pnpm run check`
detects drift.

DevHub is distributed under the [MIT License](LICENSE).
