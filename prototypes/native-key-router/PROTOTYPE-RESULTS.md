# THROWAWAY F0.3 prototype results

Date: 2026-08-22  
Status: **PASS — local CGEvent/TIS harness scope; Workbench/physical-keyboard gate remains separate**

The local F0.3 feasibility gates pass. The release gate remains open for a
real authenticated OpenVSCode Workbench and physical/manual keyboard session.

## Decision

The isolated harness compiles, its exact-prefix contract is covered by unit
tests, and the WRY change is reduced to one host-side method. A native launch
also loaded two persistent loopback child WKWebViews. This is useful feasibility
evidence. The AX-dependent smoke is still blocked, but an independent,
AX-free self-injection run now focuses the app's own NSWindow/child NSView and
posts CoreGraphics events to the app PID. That run observed trusted child
keydowns and native double-Q routing. The bounded IME run performs all
TIS query/select/restore calls on the Tauri main thread, posts unmodified
roman key events, and observed trusted Japanese composition and commit before
restoring the prior source. These are local `CGEventPostToPid`/TIS results,
not claims about physical keyboard provenance or an authenticated Workbench.

## Pins and environment

- Target: Apple Silicon arm64 macOS 26.5 (25F71).
- Rust/Cargo used for the successful build: 1.97.1.
- Tauri: 2.11.5; `unstable` and `devtools` features.
- Tauri build: 2.6.3.
- WRY: 0.55.1, local source copy under `vendor/`.
- CoreGraphics bindings: `objc2-core-graphics` 0.3.2 (`CGEventPostToPid`).
- WRY source SHA before the one local patch:
  `a5bf203a1c8dbb3583588382538d6521655222a8`.
- The test surface is a loopback external-origin page. No production or
  OpenVSCode source is changed by this prototype.

## Evidence ledger

| Gate | Result | Evidence / reason |
| --- | --- | --- |
| Router contract: first Q withheld | **PASS (unit)** | `router.rs` test asserts `PrefixArmed` and no forwarded decision. |
| Exact `1000 ms` boundary | **PASS (unit)** | The second Q at exactly the deadline forwards; one nanosecond after it starts a new prefix. |
| Unknown second key | **PASS (unit)** | Prefix clears and the event returns `Pass`; it is not stolen. |
| Defined prefix commands | **PASS (unit)** | Focus A/B and Settings route while armed. |
| Focus transition | **PASS (unit)** | Focus clears stale prefix and double-Q targets the new active child. |
| Ordinary `Command-P/Shift-P/S/Z/C/V/W/M/H` | **PASS (CGEvent scope)** | Self smoke observed trusted Command-P/Shift-P/S/Z/C/V in child A; W/M/H remain contract-only. |
| WRY patch scope | **PASS (static)** | One import and one `performKeyEquivalent` method in vendored WRY; no production change. |
| `cargo check --offline` | **PASS** | Tauri host, WRY patch, AppKit adapter, and two child WebViews compile. |
| `cargo test --offline` | **PASS** | 7 router tests plus the NDJSON observer test pass. |
| Native host launch | **PASS (partial)** | Startup log showed both child `ready`, `pageshow`, EventSource open, and loopback heartbeats. |
| Native first/second Q | **PASS (CGEvent scope)** | AX-free self smoke withheld first Q and forwarded exactly one second Q. |
| Trusted native second Q in child | **PASS (CGEvent scope)** | Child B recorded exactly one `key=q`, `trusted=true`; host recorded native forwarding with `synthetic_js=false`. |
| Japanese IME composition | **PASS (TIS/CGEvent scope)** | Main-thread TIS selected `com.google.inputmethod.Japanese.base`; the active child observed trusted composition start/update/end and input with committed `にほんご`; restore returned status `0`. |
| Hide/show/focus runtime retention | **NOT ACCEPTED** | Harness has menu/state paths, but this run cannot provide clean native focus evidence. |
| Real OpenVSCode Workbench | **NOT RUN** | This F0.3 harness uses an external observer page; authenticated Workbench proof remains a later gate. |

## Successful compile/test evidence

The following commands were run from this directory with the dependency cache
available offline:

The committed transcript is [`evidence/contract-tests.txt`](evidence/contract-tests.txt).

```text
cargo check --offline       PASS
cargo test --offline --quiet
running 8 tests
........
test result: ok. 8 passed; 0 failed
```

The vendored WRY source differs only at the intended method. The meaningful
behavior is:

```text
child + Command + keyCode 12  -> return NO (reserve Q for host prefix)
otherwise                    -> superclass performKeyEquivalent
```

The forwarding adapter constructs `NSEventType::KeyDown` from the original
event's scalar fields and calls the selected WKWebView's native
`NSResponder::keyDown`. A repository search confirms there is no forwarding
call to `eval`, `dispatchEvent`, or a DOM `KeyboardEvent`; those terms appear
only in explanatory negative assertions in the observer/docs.

## Native launch evidence and blocker

The escalated native launch printed the following observable startup lines
(the app was then stopped without claiming keyboard PASS):

```text
[F0.3] OBSERVATION_URL=http://127.0.0.1:<ephemeral>/observations.ndjson
[F0.3] test page URL=http://127.0.0.1:<ephemeral>/
[F0.3] host ready children=child-a child-b prefix_timeout_ms=1000 wry_patch=child_q_only
[F0.3] child {"source":"child","client":"child-a","kind":"ready",...}
[F0.3] child {"source":"child","client":"child-b","kind":"ready",...}
[F0.3] child {"source":"child","client":"child-a","kind":"eventsource-open",...}
[F0.3] child {"source":"child","client":"child-b","kind":"eventsource-open",...}
```

In the same session, `System Events` found the target process but reported
zero windows, and the available screen capture was black. The earlier
Tauri/WRY child-WebView feasibility prototype showed the same symptom. This
means the failure is an execution-environment/display/Accessibility blocker,
not evidence that the native event path has passed. The smoke script therefore
fails closed with:

```text
HARD_GATE: System Events could not obtain an AX-visible native window
```

The finite script run on this date exited with status `3` after roughly three
seconds of runtime automation and printed `execution error: AX: native process
has no visible window (-2700)`. Its startup observer contained both children'
`ready`/`pageshow`/`eventsource-open` records and no keydown records. The script
then terminated its own app process; it does not leave an unbounded GUI wait.

Do not replace this with a JS dispatch or an accessibility-independent claim.
Run on a logged-in display session, grant Accessibility to the terminal (or
runner), and retain the script's host log plus `observations.ndjson`.

## AX-independent CoreGraphics evidence

`./scripts/native-self-smoke.sh` was run with
`DEVHUB_NATIVE_KEY_ROUTER_SELF_TEST=1`. It exited `0` after a bounded sequence
and did not call System Events. The app itself called AppKit
`NSWindow::makeKeyAndOrderFront` plus `makeFirstResponder` for child A, then
posted `CGEventCreateKeyboardEvent` pairs with `CGEventPostToPid` to its own
PID. The observer recorded:

```text
child-a: Command-P          trusted=true
child-a: Command-Shift-P    trusted=true
child-a: Command-S/Z/C/V    trusted=true
child-a: unknown Command-K  trusted=true (prefix cleared and passed)
host: route host command=settings
host: route host command=focus target=child-b
host: forward native key equivalent key=q target=child-b synthetic_js=false
child-b: exactly one Command-Q keydown trusted=true
host: timeout prefix + final unknown-key clear
```

This is accepted as a native event-path result with a narrow scope: it proves
that CoreGraphics PID-targeted events are received by this child WKWebView as
trusted DOM events and that the host router forwards the second Q natively. It
does not prove physical keyboard timing, hardware provenance, or OpenVSCode
Workbench behavior. The sanitized transcript is
[`evidence/native-self-smoke-2026-08-22.txt`](evidence/native-self-smoke-2026-08-22.txt).

## Japanese IME evidence

`./scripts/native-ime-smoke.sh` was bounded and exited `0`. TIS current-source
query, source enumeration, selection, and restoration all run through
`run_on_main_thread`; the worker only waits on finite channels and posts key
events. The run selected
`com.google.inputmethod.Japanese.base` (the prior source was the same source
in this session), posted unmodified roman keys, and observed trusted
`compositionstart`, `compositionupdate`, `compositionend`, `beforeinput`, and
`input` records with committed `にほんご`. Restoration called
`TISSelectInputSource` on the main thread and returned status `0`; the host
recorded `source_restored=true`. The sanitized transcript is
[`evidence/native-ime-smoke-2026-08-22.txt`](evidence/native-ime-smoke-2026-08-22.txt).

This is observable local TIS/CGEvent evidence. It does not substitute for a
physical keyboard or an authenticated OpenVSCode Workbench composition run.

## Required real-machine evidence

Run `./scripts/native-smoke.sh` on the reference Mac. Accept only a run that
contains all of the following:

- child A has trusted keydown records for Command-P, Command-Shift-P,
  Command-S/Z/C/V;
- the first Q has no child keydown record and the host records one armed
  prefix;
- the second Q within 1000 ms produces exactly one host
  `forward native key equivalent ... synthetic_js=false` record and one
  trusted child Q record on the active child;
- Q followed by unknown Command-K passes the K event and clears the prefix;
- Q followed by Command-1/2/, records the defined host route;
- a second Q after more than 1000 ms does not forward and the next Q/K clears
  the newly armed state;
- focus A/B changes the forwarding target and a stale prefix never forwards to
  the old child;
- manual Japanese Hiragana composition records trusted composition and input
  events with committed text, no reload, and no EventSource loss in both
  children after hide/show/focus restoration.

The `native-smoke.sh` automation covers keyboard routing and trusted DOM
observability, but intentionally does not automate Japanese input. IME is a
separate manual evidence requirement because synthetic DOM composition would
not test AppKit's input method path.

## Remaining hard-gate risks

- Native forwarding is observed through CGEventPostToPid in the local child
  harness; it is not yet observed in the authenticated OpenVSCode Workbench or
  from a physical keyboard.
- The local loopback page is not the authenticated OpenVSCode Workbench;
  Monaco command routing and Workbench IME behavior are therefore unverified.
- AppKit menu/accessibility behavior can vary by macOS and WRY revision. Any
  WRY update must be re-pinned and the one-method diff re-audited.
- No production code may consume this feasibility result until the same
  composition and restoration behavior is repeated in the authenticated
  OpenVSCode Workbench and with the intended physical/manual input path.
