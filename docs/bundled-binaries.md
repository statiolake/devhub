# The binaries DevHub runs

**The rule: DevHub runs only the binaries it bundles or delivers — never
whatever happens to be installed on this Mac or on a host. Not node, not bash,
not tmux.** (「すべて同梱のバイナリを優先。個別のインストールされた環境依存のものをつかわないでね、nodeやbashすらも」)

A program DevHub carries is always named by a path DevHub computed —
`bundledBash()`, `bundledNeovim()`, `Runtime.tmuxProgram()`, an installed
tool's `program`, `process.execPath` — never by a bare name looked up on a
PATH. What is left is named by a literal, and every such literal is either the
operating system's (the POSIX bootstrap and base utilities, macOS's own tools)
or the person's (their shell, their ssh, their git and its credentials, the
Agent CLIs they chose). The guard test `src/main/bundledBinaries.test.ts`
scans the runtime sources for every literal program in an `argv`, a `file`, a
`spawn`/`execFile`, an array that starts a `-c`, and a script's `#!`, and fails
on one that is not on its list with a reason; it also fails on any
`/usr/bin/env` lookup and on a script that starts `sh`, `bash`, `node`, `tmux`,
`nvim`, `python`, `perl` or `ruby` by name.

## What DevHub carries

| binary | here (this Mac) | on an SSH host |
| --- | --- | --- |
| Electron 43.7.7 (its Node runs main and every utility process: process host, pty host, Neovim host, conversation engine; and the login-environment printer as `ELECTRON_RUN_AS_NODE=1`) | the app | — |
| Neovim 0.12.6 | `out/nvim` (`build:nvim`) | delivered, `~/.devhub-server/nvim/<v>` |
| bash 5.3.20 | `out/bash` (`build:bash`): Linux, the published static tarball; macOS, `scripts/build_bash.py darwin-arm64`, built from the same pinned source and patches, linked against libSystem only, signed by packaging | delivered, `~/.devhub-server/bash/<v>` (static, musl) |
| tmux 3.7c | `out/tmux` (`build:tmux`): Linux, the published static tarball; macOS, `scripts/build_tmux.py darwin-arm64`, linked against libSystem only, signed by packaging. `runtimes.tmux` is retired | delivered, `~/.devhub-server/tmux/<v>` |
| the `devhub` command (Go) | `out/cli/<os>-<arch>/devhub`, exec'd by the launcher | delivered, `~/.devhub-server/devhub/<digest>` |
| libghostty-vt | `out/vt/ghostty-vt.wasm` | — |
| node-pty | its N-API prebuild in `node_modules` | — |
| helpers | `out/native/devhub-exec-clean`, `devhub-footprint`, `devhub-input-source` (C, built by `build:native`) | — |
| speech recogniser | `Resources/whisper/devhub-whisper{,-server}` | — |

## The inventory

Every place DevHub starts a program at runtime, with its category:
**(a)** switched to a bundled/delivered binary, **(b)** bundled newly,
**(c)** inherently the system's or the person's, and why.

### Shells and interpreters

| what | where | | why |
| --- | --- | --- | --- |
| Claude Agents' `CLAUDE_CODE_SHELL` / `SHELL`, here | `LocalRuntime.claudeShell` | **(b)** | was: nothing set, so Claude Code took the PATH's zsh or bash. Now `out/bash/bin/bash`, for the Agent's process only. The person's own `SHELL` is untouched elsewhere |
| Claude Agents' `CLAUDE_CODE_SHELL` / `SHELL`, on a host | `RemoteShellRuntime.claudeShell` | **(a)** | was: the host's bash or zsh when it had one, the delivered bash only when it had neither. Now always the delivered bash; the probe of the host's shells is deleted |
| `sh -c` (the Neovim keeper, a host's Neovim socket directory, the Agent session readers in `resume.ts`, `find -exec sh`) | `managedNeovim.ts`, `neovimMachines.ts`, `resume.ts`, `remoteShellRuntime.ts` | **(a)** | were the PATH's `sh`; now `/bin/sh` by path, like every other script |
| `/bin/sh` — the GUI Agent host and its `STREAM`/`WRITE`/`RESTART`/`SENT_LOG`/`ENDING` scripts, `pathLinks`, `embedFiles`, tool installs, every host command, popups, the `nvim` shim and the `devhub` launchers (`#!/bin/sh`) | many | **(c)** | the POSIX bootstrap: the one shell every macOS and Linux (busybox included) has at that path, and the only one a host has before DevHub has delivered anything. The scripts are POSIX `sh` and exec DevHub's own binaries by path |
| node | — | — | no system `node` runs anywhere: the login-environment printer and every utility process are Electron's Node; the `devhub` command is Go |
| bash | — | — | no runtime script runs bash or has a `#!/usr/bin/env bash`; only build and development scripts do (`scripts/*.sh`, `apps/desktop/scripts/dev.sh`, which a checkout's launcher starts), and those are not part of the app |
| the person's login shell (`$SHELL -i -l -c`) to import their environment | `loginEnvironment.ts`; on a host `$SHELL -lc 'env -0'` (then `/bin/sh -lc`) | **(c)** | the environment being read *is* their shell's: their PATH for their own tools (git, gh, the Agent CLIs). The printer is Electron (`ELECTRON_RUN_AS_NODE`), not a node |
| a pane's shell (`runtimes.shell`, tmux's `default-shell`), a popup's shell, Neovim's `:!` | tmux, `POPUP_SCRIPT`, Neovim | **(c)** | the person's interactive shell (zsh) in their panes is theirs |

### Bundled programs, by path

| what | where | |
| --- | --- | --- |
| Neovim: the keeper's `nvim --headless --listen`, the shim's `nvim --embed`, the shim's tty-key reader `nvim -l` | `managedNeovim.ts`, `terminalNeovimShim.ts`, `terminalNeovimTtyKeys.ts` | bundled/delivered, by absolute path (`$real`) |
| tmux, the server and every client (node-pty, `tmux -C`, bounded commands) | `terminal/tmux.ts`, `ptyHost/`, `surfaces.ts` | bundled (`terminal/bundledTmux.ts`) / delivered, by absolute path |
| a pane's `tmux` (typed, a binding's `run-shell`, `copy-pipe`, a popup's) | `paneTmuxScript`, beside the `nvim` shim and first on every pane's PATH | bundled/delivered, by absolute path (`docs/terminal-mode.md`, "DevHub's tmux") |
| the `devhub` command | the launcher (`cli/install.ts`), a host's shim (`terminal/launcher.ts`) | bundled/delivered |
| `devhub-exec-clean`, `devhub-footprint`, `devhub-input-source`, `devhub-whisper{,-server}` | `cleanSpawn.ts`, `taskManagerReading.ts`, `inputSourceHelper.ts`, `voice/` | bundled |

### The system's (category c)

| program | where | why |
| --- | --- | --- |
| `rm`, `mv`, `test`, `sleep` as argv; `cat`, `tail`, `wc`, `mkfifo`, `kill`, `mkdir`, `chmod`, `mktemp`, `stty`, `printf`, `head`, `ls`, `id`, `uname`, `tar`, `env -0`, `awk`, `sed`, `sort`, `find`, `stat`, `date`, `readlink` inside the scripts | `neovimMachines.ts`, `cliSettingsFile.ts`, `conversation.ts` (`sleep` as a placeholder CLI), the host scripts, the shim | POSIX base utilities, on whichever machine the runtime is. A host's layout is not known, so they are named, not pathed; DevHub relies on their POSIX behaviour only (and handles the GNU/BSD/busybox differences in `stat`, `date`, `sleep 0.1`) |
| `ps` | `tmux.ts` (an Agent pane's process tree, here or on a host), `resume.ts`'s pane script (else `/proc`) | POSIX base utility |
| `/bin/ps` | `taskManagerReading.ts` (this Mac's Task Manager) | macOS's own, by path |
| `lsof` | `resume.ts` (Codex's open rollout files where there is no `/proc`) | macOS base system (`/usr/sbin/lsof`); Linux reads `/proc` |
| `/usr/sbin/sysctl`, `/usr/bin/vm_stat` | `diagnostics/systemMemory.ts` | macOS's own memory readings |
| `/usr/bin/open -a DevHub.app` | `cli/install.ts`'s launch command | macOS's launcher, starting the app itself |
| Electron's `shell.openExternal` / `openPath` | links, files | the system's handler for a URL or file, by design |

### The person's (category c)

| program | where | why |
| --- | --- | --- |
| `ssh` (`sshPath`, default `ssh` on the login PATH) | `runtime/ssh.ts` | the person's keys, agent, `~/.ssh/config`, ProxyJump, FIDO support; a bundled ssh would not read them as theirs does |
| `git` (`runtimes.git`), and `git check-ignore` for the Orchestrator's file listing | `shell/git.ts`, `repositoryStatus.ts`, `orchestratorFiles.ts` | the person's repositories, config, hooks, signing and credential helpers |
| `gh` | `shell/github.ts` | the person's GitHub sign-in |
| the Agent CLIs (`claude`, `codex`, a profile's `command`), their usage readers, MCP sign-in | `agentWiring.ts`, `hostCommand.ts`, `usageReaders.ts`, `mcpSignIn.ts` | the programs the person chose and keeps up to date; DevHub runs them by the path it resolved |
| a picker's command source (`[[workspace_sources]] command`) | `workspacePicker.ts` | the person's own command, by their configuration |

## What is not DevHub's to fix here

- **The Agent CLIs' own interpreter.** Claude Code installed with `npm i -g`
  is a node script (`#!/usr/bin/env node`): it runs the machine's node, which
  DevHub cannot replace. Its native build (`claude install`, under
  `~/.local/bin/claude`) needs none. Codex is a native binary.
- **Codex's shell.** Codex runs its commands in the person's login shell, and
  reads no `CLAUDE_CODE_SHELL`; DevHub sets nothing for it.
- **Neovim plugins.** What the person's Neovim config starts is theirs. The
  vscode-incremental-diff plugin's bundled JS server needs a `node`; its Go
  port is a separate task.

## Checked

`src/main/bundledBinaries.test.ts` (the guard), `runtime/bundledBash.test.ts`
(the bundled bash is the pinned version and is what a local Claude Agent
gets), `runtime/agentShell.test.ts` and the host install in `ssh.test.ts`; the
smoke test (`scripts/smoke_packaged_app.py`) requires `out/bash/bin/bash` in
the packaged layout and runs it with an empty environment, and requires
`out/tmux/bin/tmux`, runs it, and checks that the app's tmux server is that
binary and that a pane's `tmux` runs it.
