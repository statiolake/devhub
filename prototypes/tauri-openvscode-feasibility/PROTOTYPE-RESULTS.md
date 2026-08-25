# THROWAWAY prototype results: Tauri child WKWebViews and OpenVSCode feasibility

Date: 2026-08-22  
Status: throwaway feasibility result; not a production sign-off

## Recommendation

**Tauri accepted with a narrowly pinned host WRY fork, conditional on a native
Command+Q forwarding implementation.** The shell plus child-WKWebView topology
and ordinary Command-key path worked on the target arm64 macOS runtime only
after changing Wry's child `performKeyEquivalent` behavior. The prototype's
Command+Q second press is deliberately not counted as native OpenVSCode
evidence: it dispatches a synthetic `isTrusted=false` DOM event through a
test-only page hook. Before production, replace that hook with a native event
routing design and repeat the test in an actual OpenVSCode Workbench.

This recommendation does not authorize an OpenVSCode fork. OpenVSCode Server,
Code-OSS, and the Workbench remain upstream/pinned and unmodified. The VS Code
Integrated Terminal remains unrestricted/upstream. Only the Tauri/WRY host side
is a possible local fork boundary.

## Pins and environment

- Hardware/runtime: Apple Silicon `arm64`, macOS `26.5` (`25F71`), native GUI
  launch.
- Rust: `rustc 1.97.1`, Cargo `1.97.1`.
- Tauri: `2.11.5`, with the `unstable` feature enabled for `Window::add_child`.
- Tauri build: `2.6.3`.
- Wry: `0.55.1`, vendored under `vendor/wry/` and selected through the local
  `[patch.crates-io]` override.
- The local source tree `~/path/to/vscode` reports Code-OSS
  `1.107.0`, but has no installed `node_modules`/web build output. No source
  build or OpenVSCode Workbench run was claimed here.

## What was implemented

1. One Tauri shell WebView plus two child external-origin WKWebViews, attached
   through the unstable child API.
2. A loopback-only HTTP/SSE/heartbeat test server and a test page that records
   trusted keydown events, page loads, visibility, focus activity, and socket
   liveness without any Tauri API injection.
3. Stable per-child data directories and data-store identifiers, disabled
   background throttling, explicit `set_bounds` on resize, and menu-driven
   focus/hide/show.
4. A centralized prototype prefix state machine. First Command+Q arms it;
   another Command+Q before the timeout targets the active child. The timeout
   is `900 ms`, a provisional test value rather than a product decision.
5. A pinned Wry host patch at
   `vendor/wry/src/wkwebview/class/wry_web_view.rs`. Upstream Wry 0.55.1
   returns `NO` for every child `performKeyEquivalent`, explicitly noting that
   this makes Command-key events unavailable to JavaScript. The patch returns
   `NO` only for child Command+Q (macOS key code 12) and delegates all other
   Command equivalents to the native WKWebView.

## Evidence ledger

| Test | Result | Observation |
| --- | --- | --- |
| `cargo check` | PASS | Tauri 2.11.5 and vendored Wry 0.55.1 compile with the child API and patch. |
| Native launch | PASS | One shell and two child pages loaded from the loopback external test server. Both showed `EventSource open` and advancing heartbeats. |
| Command+P | PASS on test page | Child A recorded `keydown ⌘p`, `code=KeyP`, `trusted=true`. |
| Command+Shift+P | PASS on test page | Child A recorded `keydown ⌘⇧p`, `code=KeyP`, `trusted=true`. |
| Command+S/Z/C/V | PASS on test page | Child A recorded trusted DOM keydowns for each after native `Command+1` focus. |
| First Command+Q | PARTIAL | The app did not quit and the reserved menu accelerator was owned by the host. Native routing was not proven in a real Workbench. |
| Second Command+Q | NOT ACCEPTED as native proof | The test page logged `FORWARDED synthetic ⌘Q ...` followed by `trusted=false`. This validates only the prototype state transition/target, not Workbench delivery. |
| Hide/show A and B | PASS for retention | Visibility logs showed hidden→visible transitions; load tokens stayed unchanged, data-store load count stayed at `1`, EventSource stayed open, and heartbeats continued (sample reached 218). |
| Resize / `set_bounds` | PASS | Resizing the native window to approximately `1000×700` visibly recomputed the two child bounds without reload. |
| Focus restoration A | PASS | Native `Command+1` focused A; plain text entered the A textarea and trusted shortcut logs remained there. |
| Focus restoration B | INCONCLUSIVE | The attempted menu-driven capture occurred while the macOS menu/another app was frontmost, so no clean B typing assertion is counted. B did receive trusted `Command+2` menu accelerator records in its event log. |
| Japanese IME | NOT RUN | No automated IME run was performed. Manual steps are below. |
| Ten-minute hidden run | NOT RUN | The observed hide/show run was minutes, not the requested ten-minute soak. |
| Actual OpenVSCode/Code-OSS workbench | NOT RUN | Local Code-OSS source was inspected only; no web build or authenticated `?ew=true`/`?folder=...` run was performed. |

Useful runtime screenshots from the native run were captured outside this
prototype at `/private/tmp/wayfinder-throwaway-runtime-front.png`,
`/private/tmp/wayfinder-throwaway-normal-cmd.png`,
`/private/tmp/wayfinder-throwaway-cmdshiftp.png`,
`/private/tmp/wayfinder-throwaway-hide-show-front.png`, and
`/private/tmp/wayfinder-throwaway-resize.png`. They are ephemeral local evidence,
not checked-in product assets.

## Precise manual IME follow-up

On macOS with the Japanese input source enabled:

1. Launch the prototype and invoke native `Command+1` to focus child A.
2. Switch to Japanese input using the macOS input-source shortcut/menu.
3. Type `nihongo`, convert candidates, and press Return. Confirm the text is
   composed in the child textarea and no unexpected page reload occurs.
4. Use the app menu to hide/show child A, then invoke `Command+1` again and
   continue composition/typing. Repeat for child B with `Command+2`.
5. Record whether composition events, focus restoration, load token, and
   EventSource state survive. This must be repeated in the real OpenVSCode
   Workbench before claiming IME support.

## Unresolved risks and boundaries

- Native trusted Command+Q forwarding into a child WKWebView is unresolved;
  the current `eval` hook is a test-only synthetic event and must not ship.
- Normal shortcut delivery was proven only with the local external test page,
  not with OpenVSCode's Monaco/Workbench command routing.
- Global `?ew=true`, one folder client, authentication tokens, WebSocket/session
  continuity, editor dirty state, unsaved/hot-exit, and integrated terminal
  behavior were not tested. The integrated terminal is intentionally not
  restricted by this prototype.
- Only two workbenches were exercised. One/three/five child scaling, memory,
  CPU, process lifetime, crash recovery, and long hidden throttling behavior
  remain unmeasured.
- App bundle/signing/notarization, production CSP, permissions, origin policy,
  navigation/download behavior, and security boundaries were not evaluated.
- The 900 ms prefix timeout is provisional and has no UX/accessibility decision.
- Tauri's child API remains unstable in the pinned version; an upstream API or
  behavior change could invalidate the host patch.

## Decision boundary

The prototype answers the narrow host question positively: Tauri can host two
persistent child WKWebViews, and a pinned host-side Wry change allows ordinary
Command-key equivalents to reach JavaScript. It does not answer the full
OpenVSCode product question. The next implementation gate is a real,
authenticated upstream OpenVSCode/Code-OSS workbench run plus native
Command+Q routing and the IME/hidden-session tests above. Until those pass, keep
this directory and every file in it labeled **THROWAWAY**.
