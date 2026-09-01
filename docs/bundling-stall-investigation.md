# The bundled packaging, and the stall that was never its fault

This branch (`bundled-packaging`) holds the work that makes the packaged app a
real bundled build instead of a zipped source checkout. It is **not on `main`**:
it was reverted there because it could not be verified end to end, not because
it is wrong.

**The stall that stopped that verification is solved, and the fix is on `main`.**
It had nothing to do with bundling, nothing to do with this branch, and nothing
to do with Electron's libuv integration. It was the code signature.

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

## The symptom, as it looked

Launch the packaged app. It starts: App Shell, Scratch workbench, extension
host, agent host, bridge extension, control socket listening. Then, about two
seconds in, everything on the Node side stops.

- Timers stop. A 250 ms `setInterval` in the entry fires eight or nine times
  and never again. An independent `setTimeout` chain stops at the same instant.
- Unix-socket connections are accepted by the kernel — `connect()` succeeds —
  but no `connection` or `data` event ever reaches JS, so every `devhub`
  command hangs forever with no reply.
- VS Code's own single-instance IPC is just as dead: a second launch against
  the same `--user-data-dir` never exits.
- The process stays alive at 0% CPU.

Two independent IPC paths, both accepted and never answered, is what ruled out
the measurement and the harness early on.

## The cause

**A synchronous macOS Keychain call blocks the Electron main thread forever.**

Sampling the stalled process and reading the main thread's stack all the way
down — rather than stopping at the `[NSApplication run]` frames near the top,
which merely look like an idle app — shows it is not idle at all. Every sample,
for the whole duration, sits here:

```
v8::Function::Call -> [JS frames] -> node native
  -> SecItemCopyMatching                 (Security.framework)
    -> SecKeychainItemCopyContent
      -> CSSM_DecryptDataFinal
        -> ClientSession::decrypt
          -> mach_msg2_trap              blocked on securityd
```

Wrapping Electron's `safeStorage` names the caller exactly. The workbench asks
over IPC, and the answer never comes back:

```
ENTER safeStorage.isEncryptionAvailable 2864     <- no EXIT, ever
  caller: EncryptionMainService.isEncryptionAvailable <- ChannelServer
```

The rest follows mechanically. Because the main thread never returns from that
Chromium task, Electron never runs `UvRunOnce()`; because `UvRunOnce()` never
runs, it never calls `uv_sem_post(&embed_sem_)`; and so Electron's uv embed
thread — confirmed parked in `semaphore_wait_trap` — waits forever for
permission to poll that never arrives. The libuv loop is never pumped again.

That is why the app looks alive: Cocoa's own loop is untouched, the window is
already up, and the renderer and extension host are separate processes. Only
everything the main process's event loop was responsible for is gone.

### Why a Keychain read needed consent at all

An ad-hoc signature's *designated requirement* is the code directory hash, so
it changes with every build. A macOS keychain ACL records the requirement of
whoever stored an item. Each rebuild of DevHub therefore arrived as a stranger
to the item its predecessor had written, reading it needed the user's consent,
and Electron asks for that through the synchronous call above.

So the failure was not "the packaged app is broken". It was "this build is not
the build that wrote the keychain item", which was true of *every* build,
including every nightly.

## How it was proved

Perturbing nothing but the code signature, and putting it back:

| bundle state | cdhash | result |
| --- | --- | --- |
| as provisioned | `c87ae1ac` | healthy — 39 heartbeats, socket answers |
| one byte added, re-signed | `414f0d1f` | **stalls** — 9 heartbeats, no reply |
| byte removed, re-signed | `c87ae1ac` | healthy again — 32 heartbeats, answers |

The cdhash is deterministic for identical content, which is what makes the
experiment reversible and repeatable. It was run twice.

The complementary cut: running the **packaged app tree under the source run's
Electron bundle** is completely healthy. Same tree, same entry shim, same
materialised `node_modules`, same environment — only the bundle identity
differs. That clears the tree and the shim of any involvement.

## Ruled out, by measurement

Everything previously listed, plus the candidates the entry shim invited:

- Top-level `await import()` in the ESM entry shim — a minimal Electron app with
  and without that shape is identical (39 heartbeats each, three runs each).
- The agent host's `ERR_MODULE_NOT_FOUND` for `@github/copilot-sdk`, which
  packaging deliberately skips. It correlates (it is the last thing logged) but
  it is not causal: supplying the package changes nothing.
- `--password-store=basic` (Linux-only) and `safeStorage.setUsePlainTextEncryption(true)`
  (a no-op on macOS). Both still stall.
- Leftover instances, `~/.devhub-shared`, `~/.devhub/argv.json`, the V8 code
  cache, the crash reporter, extensions, the GPU, the agent host and shared
  process entry points, the renderer sandbox, and App Nap.

## The switch that was not one

An earlier round of this investigation recorded a table showing `VSCODE_DEV=1`
answering and `VSCODE_DEV` unset going silent, and read it as the cause. It was
not, and the reason is worth keeping.

The uncontrolled variable was **the keychain grant state**, which changes
underneath you as you experiment: a build that has been granted access answers,
and a build that has not, hangs. Any configuration can land on either side of
that depending on what ran before it, so a single run of a configuration proves
nothing about the configuration.

The lesson generalises past this bug: when a result depends on state held
outside the repository — a keychain ACL, a granted permission, a daemon's
memory — a difference between two runs is not yet a difference between two
configurations. Count several runs per configuration, and prefer an experiment
you can reverse and re-run, like the cdhash table above.

## The fix

On `main`, `ee4a2ec` — *give every DevHub bundle one identity across builds*.

`sign()` in `scripts/darwin_bundle.py` now names the designated requirement
after the bundle identifier instead of leaving it as the per-build cdhash, so
every build presents the same identity and one grant covers all of them.
`--deep` cannot carry the requirement — the nested helpers have identifiers of
their own, which it would contradict — so the tree is signed first and the outer
bundle re-signed with the requirement afterwards. Both the packaged app and the
source run's Electron clone go through that one function, so they share the
identity rather than competing for the same keychain item under different ones.

One caveat, deliberately left visible: the *first* launch after an identity
changes still waits for consent, because the existing item's ACL still records
the old requirement. That is a one-time transition, not a per-build tax. How to
handle the stale item for people who already have one is still open.

## Picking this branch back up

The blocker is gone; this branch's own work is what remains. Nothing in the
stall was caused by bundling, so nothing here needs to be redesigned around it.

`b8be089` adds the check that would have caught it in minutes, and packaging now
runs it: the packaged bundle is started against a throwaway user-data directory
and asked for its `version` over the control socket, and packaging fails if no
reply comes. Neither the socket file appearing nor a successful `connect` counts
— a stalled app lets the kernel accept a connection it will never read — so only
a reply does. It also stands alone, for CI or for a downloaded build:

```
scripts/smoke_packaged_app.py path/to/DevHub.app
```

So the bar for resuming is simply: rebase on `main`, finish the branch, and get
that smoke test passing on the bundled artifact. A bundled tree that boots and
answers is the thing this branch could never previously demonstrate.
