# The bundled packaging, and the stall that was never its fault

This is the record of the work that makes the packaged app a real bundled build
instead of a zipped source checkout, and of the stall that once kept it off
`main`. **Both are on `main` now**: the stall is fixed at its cause, and the
bundling was reapplied on top of that fix.

The stall had nothing to do with bundling, nothing to do with the branch it was
blamed on, and nothing to do with Electron's libuv integration. It was the code
signature.

## What the bundling change does

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

There is a second reason this particular state moves, and it is worth naming
because it caught two investigations in a row: **the consent is granted by a
person who has to be at the machine to see the dialog.** A build that hangs
does so because it is waiting to be let in, and whether it is ever let in
depends on whether somebody was there. So the same bundle can answer in the
morning and hang in the afternoon with nothing about it having changed.

When reading a run, separate the two questions. *Did it block?* is the one that
says something about the signature: a build that has to ask at all still has an
identity the keychain does not recognise. *Was it allowed through?* says only
who was in the room. A hang is therefore not a failure of the feature being
tested — it is the identity problem, still there.

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

## Reintroduced

The bundling is back on `main`, on top of the signing fix, and this time it was
carried all the way through the verification it could never previously survive.

- `ee4a2ec` — the signing fix, which is what made any of the rest possible.
- `b8be089` — the start-up smoke test, now run by packaging itself.
- The merge of the write-up, and the reapplied
  *ship the packaged app as a real build, not a zipped checkout*.
- A follow-up to `_stamp_state` in `scripts/darwin_bundle.py`, below.

What the bundled artifact was actually made to do, rather than merely build:

| check | result |
| --- | --- |
| control socket answers (`version`) | 6 launches, 6 answers |
| integrated terminal profile | resolves to `tmux -L devhub attach-session -t scratch` |
| extension host / pty host / shared process / agent host | all four running, `exthost.log` written |
| install from Open VSX | `pkief.material-icon-theme` v5.38.1 installed and listed |

### Two things the verification caught

**The stamp did not cover the recipe.** `_stamp_state` hashed the Electron
version and `product-overrides.json`, but not `darwin_bundle.py` itself — so
changing how bundles are *signed* did not invalidate the stamp, the branded
clone from before the fix was kept, and the fix silently did not apply to it.
That is why the keychain kept asking after the fix had supposedly landed. The
file now hashes itself into its own stamp.

**Packaging ships `apps/desktop/out` without rebuilding it.** The reapplied
change added `extensions.verifySignature: false` to the workbench defaults, but
the packaged app shipped the *previous* compile, so the setting was missing and
every gallery install failed with "Signature verification was not executed" —
the exact wall the setting exists to remove. A stale compile is invisible: the
app starts, the smoke test passes, and only a deeper action fails. Build
`apps/desktop` before packaging.

The smoke test is the floor, not the ceiling. It proves the event loop is alive,
which is the property that kept breaking; it does not prove the app can install
an extension. Both were checked here, and a stale compile passes the first while
failing the second.

```
scripts/smoke_packaged_app.py path/to/DevHub.app
```
