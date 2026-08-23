# DevHub WRY 0.55.1 fork

This directory is an auditable local fork of the crates.io `wry` **0.55.1**
source used by DevHub. The upstream package checksum before the patch is
`186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514`.

## Narrow behavior change

ADR 0013 forbids Editor child views from receiving an injected global API or
IPC capability. Upstream WRY 0.55.1 installs a `window.ipc` document-start
script even when no IPC handler was supplied. This fork keeps that historical
behavior for callers that explicitly provide an IPC handler, but omits the
script and native message-handler registration when no handler is supplied.
The raw EditorHost adapter supplies neither an IPC handler nor initialization
scripts.

The only changed backend sites are:

- `src/wkwebview/mod.rs`
- `src/webkitgtk/mod.rs`
- `src/webview2/mod.rs`

The source and public API otherwise remain WRY 0.55.1. Rebase this fork only
from the exact pinned release and re-audit those three sites. The fork is
selected by the workspace `[patch.crates-io]` entry and is not a download or
runtime network dependency.

The Editor release target is macOS 15 or later (ADR 0017), which supports
WRY's custom WKWebView data-store identifier API. Older macOS versions are not
an Editor release target; WRY's upstream fallback to its default store is
therefore not used by a supported DevHub runtime.
