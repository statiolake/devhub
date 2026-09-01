# The bundled packaging, and the stall that is not its fault

This branch (`bundled-packaging`) holds the work that makes the packaged app a
real bundled build instead of a zipped source checkout. It is **not on `main`**:
it was reverted there because it could not be verified end to end, not because
it is wrong.

**Read this first.** The stall described below — the one that stopped the
verification — turned out to be **pre-existing and unrelated to bundling**.
Building the packaged app at `046e2a9~1`, before any of this branch's work,
reproduces it exactly, and so does the packaging path on `main` today. It is
deterministic (3 of 3 runs) and `pnpm dev` is unaffected. So there are two
separate pieces of work here: finishing this branch, and fixing the packaged
app's main process. The second is the urgent one — it means the `devhub`
command does not work in the shipped app.

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

## A switch that turned out not to be one

The same packaged `DevHub.app`, same files, differing only in the environment:

| launch | heartbeats in 12s (alive ≈ 45) | control socket |
| --- | --- | --- |
| `VSCODE_DEV=1` | 47 | answers |
| (unset) | 5, then silence | no reply |

This looked decisive at the time and it is **wrong**, or at best incomplete.
The packaging on `main` sets `VSCODE_DEV=1` in its entry shim and stalls
anyway, three runs out of three. Whatever this table measured, it was not
`VSCODE_DEV`; something else varies between runs and was not controlled for.

Treat the table as a lead about *nondeterminism*, not as a cause. The one
thing it does establish is that the bundle can run correctly — in that
configuration the app answered, installed an extension from Open VSX and
resolved its tmux terminal profile.

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

The mechanism. Something stops Electron's integration between Chromium's
message loop and Node's event loop in the packaged app, and none of the
candidates above is responsible.

The loose end that matters most: the app **did** work end to end early on —
control socket, `--install-extension` from Open VSX, the tmux terminal profile
— in a configuration that later stalled every time. So the stall is either
nondeterministic or depends on something not yet identified, and any future
bisect has to control for that before trusting a single run.

## Where to pick it up

The cheapest reproduction is the heartbeat: add a `setInterval` in
`apps/desktop/src/main/main.ts` that appends to a file, package, launch, and
count the lines. Toggling `VSCODE_DEV` on the same bundle flips it.

Bisect on `main`'s own packaging first, not on this branch: the stall lives
there, the tree is smaller, and a fix belongs there anyway. Because a single
run cannot be trusted, count several per configuration.

The obvious first cut is when the packaged app last worked at all — if it
ever did — since `pnpm dev` is unaffected and the two differ almost entirely
in the entry shim (`ENTRY_SOURCE` in scripts/package-nightly.py) and in
running from a materialised tree rather than the checkout.
