# THROWAWAY F0.3 native keyboard / IME host harness

This is an isolated macOS feasibility prototype for F0.3. It answers one
narrow question: can a Tauri 2 host keep ordinary native Command shortcuts and
Japanese IME behavior in child WKWebViews while reserving exact `Command+Q`
as a one-second host prefix? It is not production code and nothing under this
directory is a production API.

The current result is a local feasibility PASS for the CGEvent/TIS path. The
AX-independent CoreGraphics self-smoke passes the trusted native-key and
double-Q path, and the bounded TIS smoke selects a Japanese source on the
Tauri main thread, observes trusted composition/commit, and restores the
previous source. This does not claim physical-keyboard provenance or an
authenticated OpenVSCode Workbench run. The AX-dependent smoke is retained as
a separate manual reference. See
[PROTOTYPE-RESULTS.md](PROTOTYPE-RESULTS.md).

## What the harness contains

- `src/main.rs`: Tauri shell, two persistent external-origin child WKWebViews,
  loopback observer server, focus/hide/show menu actions, and stable child data
  stores.
- `src/router.rs`: AppKit-independent prefix state machine with exact
  `1000 ms` deadline tests.
- `src/native.rs`: macOS local `NSEvent` monitor. The first exact Command-Q is
  withheld; a second press in the interval constructs one native AppKit event
  and calls the active child WKWebView's inherited `NSResponder::keyDown`.
  There is no `eval`, DOM `KeyboardEvent`, `dispatchEvent`, or test-page
  forwarding hook.
- `test-page.html`: an external-origin child page that records DOM
  `isTrusted`, key/modifier/repeat/composition/beforeinput/input events,
  visibility, focus, load identity, EventSource liveness, and heartbeat ticks.
  It has no Tauri API or injected script.
- `vendor/`: a local WRY 0.55.1 source copy with one macOS host-only patch;
  the exact upstream SHA and patch boundary are recorded below.
- `scripts/native-smoke.sh`: real-machine smoke automation. It refuses to
  claim PASS when macOS System Events cannot see the native window.
- `scripts/native-self-smoke.sh`: bounded CoreGraphics `CGEventPostToPid`
  self-injection. It focuses the app's own NSWindow/child NSView and does not
  enumerate windows through Accessibility.
- `scripts/native-ime-smoke.sh`: bounded Carbon TIS + CoreGraphics Japanese
  IME smoke. TIS query/select/restore runs on the Tauri main thread; key
  posting remains finite and off-main-thread. It restores the previous input
  source before claiming completion; an unavailable display/input session is
  BLOCKED.

## Run and inspect

On Apple Silicon macOS with a logged-in, visible GUI session:

```sh
cd ~/path/to/devhub/prototypes/native-key-router
cargo test --offline
cargo check --offline
cargo run --offline
```

The host prints an `OBSERVATION_URL=http://127.0.0.1:<port>/observations.ndjson`
line. The child pages are loaded from the loopback server and can also be
pointed at an already-running test page or OpenVSCode origin using
`DEVHUB_NATIVE_KEY_ROUTER_CLIENT_A_URL` and
`DEVHUB_NATIVE_KEY_ROUTER_CLIENT_B_URL`. Credentials must remain in the
process environment and must never be copied into logs or this prototype.

For a real native smoke run (requires Accessibility permission for the
calling terminal and a visible desktop):

```sh
./scripts/native-smoke.sh
```

The script saves the observer NDJSON at `evidence/native-smoke-latest.ndjson`
(ignored by default), prints the host log on exit, and exits non-zero for any
missing trusted event or missing AX window. Set
`F03_NATIVE_SMOKE_OUTPUT=/absolute/path/output.ndjson` to retain output
elsewhere.

The AX-independent keyboard run is:

```sh
./scripts/native-self-smoke.sh
```

It sets `DEVHUB_NATIVE_KEY_ROUTER_SELF_TEST=1`, posts key events to the
prototype's own PID through CoreGraphics, and requires child DOM
`isTrusted=true` records plus the host's native double-Q record. This proves
the CGEventPostToPid path as observed by this harness; it does not claim that
CGEvent injection is physically identical to a keyboard switch.

## Routing contract exercised here

The router owns one state transition and keeps ordinary AppKit behavior on the
native path:

| Input | Host decision |
| --- | --- |
| First exact `Command+Q` | consume and arm for exactly `1000 ms` |
| Second exact `Command+Q` at or before the deadline | consume and deliver one native event to the active child |
| `Command+1`, `Command+2`, `Command+,` during the prefix | consume and route Focus A/B or Settings |
| Timeout | clear lazily on the next event; a new Q starts a fresh prefix |
| Unknown second key or ordinary `Command+P/Shift+P/S/Z/C/V/W/M/H` | clear an armed prefix if applicable, then pass the original native event |
| Focus change | clear a stale prefix and make the new child the forwarding target |

The WRY patch makes child `performKeyEquivalent` return `NO` only for
Command-Q (macOS virtual key code 12). All other child Command equivalents
delegate to WKWebView, so AppKit/IME and ordinary Workbench shortcuts keep
their native route. This is a host boundary decision; OpenVSCode and the
Workbench are not forked.

## IME evidence boundary

The page's composition instrumentation is automated and observable, but
generating Japanese IME composition is intentionally not faked with DOM
events. On a real reference Mac, manual evidence must be collected as follows:

1. Launch the harness and focus A with native `Command+1`.
2. Switch macOS to Hiragana input, type `nihongo`, convert candidates, and
   commit with Return. Record `compositionstart/update/end`, `beforeinput`,
   `input`, the committed textarea value, and `isTrusted` in the observer.
3. Hide/show A and repeat after restoring focus; perform the same sequence in
   B after `Command+2`.
4. Confirm no load-token change, page reload, EventSource loss, or lost
   composition. Repeat against the real authenticated OpenVSCode Workbench
   before treating F0.3 as a release result.

The `native-smoke.sh` script proves native shortcut delivery only; it does not
claim to automate or pass Japanese IME.

The finite IME smoke can be run with:

```sh
./scripts/native-ime-smoke.sh
```

It uses Carbon TIS on the Tauri main thread to choose a Japanese
Hiragana/Kotoeri source, posts unmodified roman keys through CoreGraphics,
waits for composition/commit records, and restores the prior source on the
main thread. The latest run observed `にほんご`, trusted
`compositionstart/update/end` and `input`, and restore status `0`. It is
finite and fails closed if TIS cannot access an interactive input session.
This is local CGEvent/TIS evidence; repeat the manual sequence against the
authenticated Workbench before treating F0.3 as a release result.

## WRY pin and patch provenance

The vendored package is WRY `0.55.1`, selected by the local
`[patch.crates-io]` entry in `Cargo.toml`. Its upstream source metadata is:

```text
commit a5bf203a1c8dbb3583588382538d6521655222a8
```

The only source change is
`vendor/src/wkwebview/class/wry_web_view.rs`, in
`WryWebView::perform_key_equivalent`:

```text
if child && Command && keyCode == 12: return NO
otherwise: call the superclass implementation
```

The old upstream behavior returned `NO` for every child Command equivalent,
which dropped ordinary Command-P/S/C/V/Z before the child. The patch is kept
inside this prototype, is not applied to production, and must be re-audited
against any future WRY update. Inspect the narrow boundary with:

```sh
diff -u \
  ../tauri-openvscode-feasibility/vendor/wry/src/wkwebview/class/wry_web_view.rs \
  vendor/src/wkwebview/class/wry_web_view.rs
```

## Scope and gate

No production file is modified. No OpenVSCode build, authenticated Workbench
session, Accessibility permission grant, or physical-keyboard result is
implied by the compile/unit-test result. The local gate ledger and remaining
real-Workbench/manual boundary are in
[PROTOTYPE-RESULTS.md](PROTOTYPE-RESULTS.md).
