# DevHub without VS Code

DevHub began as a patched VS Code: the `vscode` submodule, DevHub's patches
and overlay on it, and DevHub's main process booted inside VS Code's. Its
editor is Neovim now, drawn by DevHub over each Workspace's terminal, so VS
Code was deleted: DevHub builds, tests, packages and runs without it.

**To look at or restore the VS Code code**, check out the commit before the
removal — every file (the submodule pointer, `patches/`, `extensions/`, the
VS Code main-process code, the REH and bump scripts, the docs that described
them) is in history:

    git log --oneline -- apps/desktop/src/main/codeMain.ts   # the last commit that had it is the removal's parent
    git checkout <removal>^ -- <path>

The removal is the commit titled "DevHub: its own Electron and main process;
VS Code deleted"; the submodule entry went in "Remove the vscode submodule".

## What replaced each part

| Coupling | Before | Now |
| --- | --- | --- |
| Main process boot | `main.ts`/`codeMain.ts` were copies of VS Code's `src/main.ts` and `CodeMain`: its ESM bootstrap, NLS, DI container (`CodeApplication`), single-instance IPC server, then DevHub's shell | `src/main/main.ts` is DevHub's: the profile's user-data path, its migration, the main log, the `devhub-app:` scheme, Electron's single-instance lock, the process host, `bootstrapShell`, `markReady` |
| Main services | windows, dialog, lifecycle, workspaces history and extension management from VS Code's container, behind a gate | none: the folder picker is Electron's `dialog`; quit was already `bootstrapShell`'s `before-quit` |
| `BrowserWindow` shim, app fence | turned workbench windows into views; fenced VS Code's writes to `electron.app` | deleted: nothing creates workbench windows |
| Electron | VS Code's (`vscode/.build/electron`, 43.7.7, Microsoft's build) | npm's `electron@43.7.7`, pinned in `apps/desktop/package.json`, fetched on first use by `apps/desktop/scripts/electron-path.sh` |
| node-pty | the submodule's, built for VS Code's Electron, through `requireFromSubmodule` and `node_modules.asar` | `node-pty@1.2.0-beta.15`, a direct dependency: N-API, loaded from its own `prebuilds/<platform>-<arch>` — nothing compiles |
| `enableASARSupport` | needed to resolve ESM out of `node_modules.asar` | no archive: `Resources/app/node_modules` is plain files, which every process resolves |
| Preloads | loaded under VS Code's sandbox | CommonJS bundles with a `package.json` of their own (`{"type": "commonjs"}`) |
| product.json | VS Code's, with `product-overrides.json` merged | `apps/desktop/product.json`, DevHub's alone, read from `APP_ROOT` (`main/product.ts`); the packaged copy adds `version` and `commit` |
| App root | `Resources/app/node_modules/code-oss-dev/out/main.js` (a bundle) | `Resources/app/out/main/main.js`, the same module tree as a checkout's `apps/desktop/out` |
| Packaging | VS Code's Electron renamed, `code-oss-dev/` (bundled workbench, built-ins, asar), four REH tarballs | npm's `Electron.app` renamed (`darwin_bundle.py`), `Resources/app/{package.json,product.json,out,dist,node_modules}`, `whisper/`, `licenses/` (`package-nightly.py`) |
| Signing | ad hoc, designated requirement on the bundle id | the same `sign()`; not notarized, as before |
| Document types | read from VS Code's staged bundle | `DOCUMENT_EXTENSIONS` in `darwin_bundle.py` |
| Node on an SSH host | the REH's `node`, for the `devhub` command and the launcher | nodejs.org's Linux build, pinned (`nodeVersion`, `nodeDownloadSha256`), delivered like tmux and bash; a musl host is refused by name |
| `editor` setting | `"vscode"` (default) or `"neovim"` | **retired** (below) |
| `workbench_freeze`, `workbench_discard_minutes`, `stop_editor` (`Cmd+Q Shift+E`), the Task Manager's Sleep | VS Code workbenches only | retired / deleted |
| Dev containers | a Workspace's editor attached to a container (VS Code's Reopen in Container) | deleted. A saved attachment reopens on the Workspace's own machine; `devhub <file>` inside a container is refused |
| `devhub --install-extension`, `--uninstall-extension`, `--list-extensions` | VS Code's extension CLI | deleted: refused as unknown options. `--version` prints DevHub's version and commit |
| Typecheck | `tsconfig.main.json` mapped `code-oss-dev/out/*` to the submodule's sources | no mapping, no typings: the submodule is never read |
| Tests | vitest imported `vscode/out`; `test:pty` ran in VS Code's Electron; an overlay stage | `test:pty` runs in npm's Electron; the VS Code tests went with their code |
| Provisioning, CI, nightly | `provision-vscode.sh` (~6 GB) in every macOS job; four REH builds in Docker nightly; a bump workflow | none: `pnpm install` is the whole set-up; CI never checks the submodule out |

### `editor`: retired

Neovim is the only editor, so there is nothing to choose. `general.editor`
is in `RETIRED_KEYS` (`model/config.ts`): a `settings.toml` that still says
`editor = "vscode"` or `"neovim"` loads, the key is ignored, Settings names it
once, and the next save drops it. Accepting `"neovim"` while rejecting
`"vscode"` would keep a setting whose only valid value is the default.

## User data

Nothing moves. The user-data directory is the profile's as before
(`~/Library/Application Support/DevHub/editor` by default), and DevHub's
state is `devhub/state.json` under it. What VS Code kept there (`User/`,
`workspaceStorage/`, `CachedData/`, `logs/` of its own, the extensions under
`…/DevHub/extensions`) is no longer read and can be deleted by hand.

## Measured

Build time and disk, before (VS Code provisioned) and after:

| | before | after |
| --- | --- | --- |
| disk a working checkout needs | `vscode/` 7.9 GB + `vscode-toolchain/` 0.2 GB + `node_modules` 0.9 GB ≈ 9.0 GB | `node_modules` 0.74 GB (Electron 0.32 GB of it) |
| cold set-up (fresh clone) | provisioning: 16 min on CI's macOS runner (nightly, cache miss); the README said 40–60 min on a Mac | see the removal's follow-up commit message and the table in the final report |
| warm, per CI macOS job | 3–4.3 min restoring the provisioned cache, before any check | none |
| the desktop build | ~30 s | ~24–30 s |
| packaged `Resources/app` | `code-oss-dev/` workbench bundle, built-ins and asar | 21 MB |

## What is left to delete

These no longer have a VS Code to drive them and are unreachable, but are
woven through code that stays, so they are a later step:

- the workbench *view* plumbing in `shell/shellWindow.ts` and
  `shell/workbenchView.ts`, the `workbench` children of `windowLayout.ts`,
  the `workbench` layout kind in the model and the Task Manager's workbench
  rows (`diagnostics/taskTree.ts`);
- the `terminal-profile` control request and the terminal launcher's asking
  program (`terminal/devhubTerminal.ts`), which answered VS Code's integrated
  terminal; the remote launcher still installs the host's `devhub` command
  beside it;
- the `EditorAttachment` (`host` | `devContainer`) in the model and the state
  file, now always `host`;
- passages of `docs/window-and-pages.md` and `docs/remote-ssh.md` that
  describe the above.
