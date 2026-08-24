# DevHub WRY 0.55.1 fork

This directory is an auditable local fork of the crates.io `wry` **0.55.1**
source used by DevHub. The upstream package checksum before the patch is
`186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514`.

## Narrow behavior changes

ADR 0013 forbids Editor child views from receiving an injected global API or
IPC capability. Upstream WRY 0.55.1 installs a `window.ipc` document-start
script even when no IPC handler was supplied. This fork keeps that historical
behavior for callers that explicitly provide an IPC handler, but omits the
script and native message-handler registration when no handler is supplied.
The raw EditorHost adapter supplies neither an IPC handler nor initialization
scripts.

The fork also supplies the narrow macOS host hooks required by I4.4 Keyboard
routing. The App Shell installs one local AppKit key monitor, while WRY copies
only scalar event metadata (including repeat state, window identity/number,
and first-responder ancestry) across the application seam. Native WebView
identity and owning-window metadata are exposed for raw Editor children. The
host validates semantic SurfaceKey, lifecycle generation, window identity and
responder ancestry before returning the original NSEvent for forwarding. No
synthetic DOM event is created.

The only changed backend sites are:

- `src/wkwebview/mod.rs`
- `src/webkitgtk/mod.rs`
- `src/webview2/mod.rs`
- `src/lib.rs`
- `src/wkwebview/class/wry_web_view.rs`
- `src/wkwebview/class/wry_web_view_parent.rs`

The macOS hooks are deliberately host-only: the first Command-Q is consumed,
the second is returned as the same trusted NSEvent at most once, and ordinary
Command shortcuts, text editing, focus, and IME paths continue through the
native responder chain. Child OpenVSCode WebViews receive no Tauri IPC or
global API. Agent/Terminal activities may share the App Shell native WebView,
but retain distinct semantic SurfaceKeys. This is a local patch boundary, not
an upstream publication or a provider protocol change.

The source and public API otherwise remain WRY 0.55.1. Rebase this fork only
from the exact pinned release and re-audit all sites above. The fork is
selected by the workspace `[patch.crates-io]` entry and is not a download or
runtime network dependency.

## Verification and rebase boundary

The current local evidence is reproduced with the pinned toolchain:

```sh
RUSTUP_TOOLCHAIN=1.97.1 cargo fmt --all -- --check
RUSTUP_TOOLCHAIN=1.97.1 cargo check -p devhub-app --locked
RUSTUP_TOOLCHAIN=1.97.1 cargo check -p devhub-app --target aarch64-apple-darwin --locked
RUSTUP_TOOLCHAIN=1.97.1 cargo test -p devhub-app keyboard::tests --locked
RUSTUP_TOOLCHAIN=1.97.1 cargo clippy -p devhub-app --all-targets --all-features --locked -- -D warnings
CI=true pnpm run check
CI=true pnpm run build
CI=true pnpm --filter @devhub/app exec tauri build --debug --no-bundle
```

The focused suite has 9 passing router tests; the unsandboxed full check has
222 native tests passing and 3 intentionally ignored. Real Apple Silicon
OpenVSCode/xterm forwarding, live responder ancestry with WebKit input views,
ordinary shortcut behavior, and Japanese IME behavior remain interactive
Q5.1 evidence, not claims made by this source-level patch.

The Editor release target is macOS 15 or later (ADR 0017), which supports
WRY's custom WKWebView data-store identifier API. Older macOS versions are not
an Editor release target; WRY's upstream fallback to its default store is
therefore not used by a supported DevHub runtime.
