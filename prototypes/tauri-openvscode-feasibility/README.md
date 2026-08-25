# THROWAWAY Tauri/OpenVSCode feasibility prototype

This directory is an isolated, **THROWAWAY** macOS prototype. It answers one
narrow question: can one Tauri window host a shell WebView plus child WKWebViews
without losing normal Command-key events, while reserving Command+Q as a
Wayfinder prefix? It is not a production architecture and must not be treated
as one.

## What is here

The Rust host creates one shell window and two child `Webview<Wry>` instances
using Tauri's unstable `Window::add_child` API. By default both children load a
loopback-only external test page served by the prototype itself. The page
records trusted DOM keydown events, visibility transitions, a localStorage page
load token, an EventSource connection, and a periodic heartbeat.

The child data directories and WKWebView data-store identifiers are stable for
the life of this prototype. Child background throttling is disabled. The app
menu provides focus, hide/show, and resize paths that exercise the host state
model.

## Run

On the pinned environment (Apple Silicon macOS with Xcode command-line tools):

```sh
cd ~/path/to/devhub/prototypes/tauri-openvscode-feasibility
cargo check
cargo run
```

`cargo run` starts a loopback test server and opens the native macOS window.
The window menu is named `Wayfinder THROWAWAY`; `Command+1` and `Command+2`
focus the two children. The menu's hide/show items preserve the child objects.
`Command+Q` arms the prefix state machine; a second press within the current
900 ms prototype timeout invokes the test-only forwarding hook. There is no
Quit menu item or keyboard Quit shortcut.

The default children are deliberately a local external-origin test surface.
To point them at an already-running, authenticated OpenVSCode Server instance,
set both URLs before launching. Keep the server loopback-bound and retain its
connection token; do not disable token authentication or paste a real token
into logs, source, or this README:

```sh
WAYFINDER_CLIENT_A_URL='http://127.0.0.1:PORT/?ew=true&connectionToken=REDACTED' \
WAYFINDER_CLIENT_B_URL='http://127.0.0.1:PORT/?ew=true&folder=%2Fabsolute%2Fworkspace&connectionToken=REDACTED' \
cargo run
```

The host appends `client=client-a` or `client=client-b` to each URL for test
identification. In a real run, replace the redacted values in the shell
environment only; never commit or print credentials.

## Keyboard boundary

`vendor/wry` is a pinned, local **THROWAWAY host-side fork** of Wry 0.55.1. Its
only behavioral change is in macOS `WryWebView::performKeyEquivalent`: child
Command+Q returns `NO` so the app menu can own the reserved accelerator, while
all other child Command key equivalents delegate to the native WKWebView. This
is the smallest isolated host patch found by this experiment.

OpenVSCode Server, Code-OSS, and the Workbench are **not forked or modified**.
They remain upstream/pinned inputs. The VS Code Integrated Terminal is not
restricted by this prototype and remains part of the upstream workbench. If a
production implementation proceeds, only the Tauri/WRY host integration may
need a narrowly pinned fork; upstream editor changes are out of scope.

The second Command+Q action currently calls a test-page function that dispatches
a synthetic, untrusted DOM event. This proves only that the prefix state machine
does not quit and targets the active child. It is **not** evidence that a real
OpenVSCode Workbench receives a native trusted Command+Q. Native event routing
for that forwarding path remains explicitly unverified; see
`PROTOTYPE-RESULTS.md`.

## Security and scope

The built-in test server binds to `127.0.0.1` and has no credentials. The child
WebViews are external-origin surfaces with no Tauri capabilities and no injected
Tauri global or initialization script. This is a test harness, not a security
boundary review. Bundling, signing, production CSP, remote-origin policy,
resource limits, and OpenVSCode authentication/session handling remain future
work.

For the complete evidence ledger, pass/fail table, and unresolved risks, read
`PROTOTYPE-RESULTS.md`.
