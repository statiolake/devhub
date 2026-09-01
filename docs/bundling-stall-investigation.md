# The packaged bundle stalls its own main process

This branch (`bundled-packaging`) holds the work that makes the packaged app a
real bundled build instead of a zipped source checkout. It is **not on `main`**:
the commit was reverted there because the app it produces has a main process
that stops answering, and the CLI is the visible casualty.

This file is the investigation, written down so restarting it costs an hour
rather than a day.

## What the branch does

`08d086e` — *ship the packaged app as a real build, not a zipped checkout*.
Provisioning builds `out-vscode-min/` beside `out/` under one stamp,
`package-nightly.py` ships the bundled tree, DevHub's own main process is
esbuild-bundled to `code-oss-dev/out/main.js` (upstream's own entry path, which
is what makes `appRoot`, `_VSCODE_FILE_ROOT` and `NODE_MODULES_PATH` resolve),
and the packaged entry stops setting `VSCODE_DEV`.

That last line is the point of the whole change: upstream renames the product
to "<name> Dev" whenever `VSCODE_DEV` is set, so the nightly on GitHub called
itself "DevHub Dev".

## The symptom

Launch the packaged app. It starts: App Shell, Scratch workbench, extension
host, agent host, bridge extension, control socket listening. Then, about 1.3
seconds in, **the main process's Node event loop stops**.

- Timers stop. A 250 ms `setInterval` registered in `main.ts` fires through
  `+1516ms` and never again.
- Unix-socket connections are accepted by the kernel — `connect()` succeeds —
  but no `connection` or `data` event ever reaches JS, so every `devhub`
  command hangs forever with no reply.
- The process stays alive at 0% CPU. `sample` shows the main thread idle in
  `[NSApplication run] -> nextEventMatchingMask`, **not** blocked in JS.

## It is not the instrumentation

A second instance launched against the same `--user-data-dir` **never exited**
(observed for 10 minutes). That is VS Code's own single-instance IPC, not
DevHub's control socket. Two independent IPC paths, both accepted and never
answered, is what rules out the measurement and the harness.

## The one switch

The same packaged `DevHub.app`, same files, differing only in the environment:

| launch | heartbeats in 12s (alive ≈ 45) | control socket |
| --- | --- | --- |
| `VSCODE_DEV=1` | 47 | answers |
| (unset) | 5, then silence | no reply |

`VSCODE_CLI=1` does **not** substitute — it stalls. So the trigger is
`VSCODE_DEV`, which is to say the `isBuilt` path inside VS Code, not the
bundling. **The bundle is innocent**: with the flag set it is a fully working
app.

## Ruled out, by measurement

Each of these was tested and did **not** change the outcome:

- Other agents' in-flight code (clean tree reproduces) and the code itself
  (rebuilding at `08d086e` reproduces).
- Leftover instances holding shared resources.
- `~/.devhub-shared` shared storage (moved aside; recreated fresh).
- `~/.devhub/argv.json` — byte-identical to the `-dev` copy apart from the id.
- V8 code cache (`--no-cached-data`).
- Crash reporter (`"enable-crash-reporter": false`).
- Extensions (`--disable-extensions`), GPU (`--disable-gpu`).
- Agent host and shared process (entry points removed from the bundle).
- Renderer sandbox (`--no-sandbox`).
- macOS App Nap (`defaults write dev.devhub.app NSAppSleepDisabled -bool YES`),
  despite the process showing the low-priority `SN` state that suggested it.

## What is not known

The mechanism. Something on the `isBuilt` path stops Electron's integration
between Chromium's message loop and Node's event loop, and none of the obvious
consumers of `isBuilt` above is responsible.

One loose end worth keeping: the app **did** work end to end once, early on —
control socket, `--install-extension` from Open VSX, the tmux terminal profile
— in the same configuration that later stalled every time. Either something
about that run differed in a way not captured here, or the stall is not fully
deterministic. Assume the latter until shown otherwise.

## Where to pick it up

The cheapest reproduction is the heartbeat: add a `setInterval` in
`apps/desktop/src/main/main.ts` that appends to a file, package, launch, and
count the lines. Toggling `VSCODE_DEV` on the same bundle flips it.

The next thing to try is bisecting `isBuilt` itself — patch
`environmentMainService.isBuilt` to return `false` in a packaged build and see
whether the loop survives. That separates "something reads `isBuilt`" from
"something reads `VSCODE_DEV` directly", which no experiment here has done.
