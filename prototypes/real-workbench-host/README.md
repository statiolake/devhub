# THROWAWAY: real OpenVSCode Workbench host

This directory is a Wave 0 feasibility harness, not production code. It proves
the real pinned OpenVSCode Server topology in one Tauri 2 / WRY native window:
one folderless child and two folder children as external WKWebViews. Delete the
directory when the decision is recorded.

OpenVSCode is upstream and unchanged. The source tree is outside this
repository at `/private/tmp/openvscode-darwin-arm64-feasibility/source`; this
harness does not patch or fork it. The only reused host patch is the isolated
throwaway WRY vendor tree selected by `Cargo.toml`.

## Contents

- `src/main.rs` — one native shell and three authenticated child WebViews.
- `fixture-extension/` — an independent copy of the F0.4 public-API fixture,
  extended only for this prototype's per-workspace identity, shared-storage,
  and hot-exit observations.
- `fixture-host/bridge-host.mjs` — dependency-free Bridge v1 host fixture.
- `scripts/run-f02-evidence.mjs` — finite end-to-end F0.2 runner and ledger.
- `scripts/run-f02-lifecycle-evidence.mjs` — explicit lifecycle-audit entry
  point using the same canonical runner/ledger.
- `scripts/build-fixture-vsix.sh` — packages the fixture VSIX with the expected
  `extension/package.json` layout.
- `scripts/start-server.sh`, `run-host.sh`, `smoke-loopback.sh`, and
  `continuity-check.sh` — bounded manual topology/continuity helpers.
- `evidence/` — redacted run-specific logs and the `PROVEN/PARTIAL/BLOCKED`
  ledger. No connection token is retained.

The host gives all children one persistent WebKit data root and one stable
`data_store_identifier`, disables background throttling, redacts URL queries,
and grants remote children no Tauri capabilities. Folder identity is supplied
by the upstream Workbench URL. The fixture uses only public VS Code APIs:
`ExtensionContext.globalState`, `workspaceState`, `workspace.fs`,
`openTextDocument`, `TextEditor.edit`, and the public document model.

## Exact pinned checks

Prerequisites for the recorded run:

- macOS Tahoe 26.5 (25F71), arm64;
- Rust/cargo **1.97.1** from `rust-toolchain.toml`;
- Tauri 2.11.5 and WRY 0.55.1 API via the existing throwaway vendor patch;
- the pinned artifact at
  `/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64`;
- Node 22.21.1 embedded in that artifact.

```sh
cd ~/path/to/devhub/prototypes/real-workbench-host

rustc --version                 # rustc 1.97.1
cargo fmt -- --check            # PASS
cargo check --offline           # PASS (existing WRY warnings only)
cargo test --offline            # PASS (0 tests; native checks are in the runner)
scripts/smoke-loopback.sh       # optional authenticated HTTP smoke
```

The pinned OpenVSCode artifact must already exist at the path above. The
runner builds the fixture VSIX, builds the native host offline, installs the
VSIX into a fresh extensions directory, and performs all remaining checks:

```sh
node scripts/run-f02-evidence.mjs
```

The lifecycle-audit entry point is equivalent and makes the audited mode
explicit in the canonical ledger:

```sh
scripts/run-f02-lifecycle-evidence.mjs
```

The runner requires permission to bind loopback and create native windows.
It creates one generated runtime under `/private/tmp`, uses a random owner-only
token, and removes that runtime in `finally`.

## What the F0.2 runner proves

The finite scenario uses two generated folders (`workspace-a` and
`workspace-b`) and one folderless child. All three use the same authenticated
loopback origin and the same WebKit root. The OpenVSCode server receives one
profile (`--user-data-dir`), one server-data directory, and one extensions
directory for both phases.

1. Workspace A writes a unique value through `context.globalState` and its own
   `context.workspaceState`; Workspace B reads both through the public API.
   The ledger requires the global value to match and the workspace value to be
   absent. Marker files are written through `vscode.workspace.fs` only to make
   the result observable without relying on extension-host stdout.
2. Workspace A creates a real file-backed dirty document through public VS Code
   APIs. The runner waits eight seconds for the upstream backup debounce, then
   closes the native window through a host-side control marker. It observes
   `CloseRequested` and `Destroyed`, keeps the exact same OpenVSCode server PID,
   port/origin, profile, server data, extensions directory, and WebKit store,
   writes a restore-request marker, and relaunches the native host.
3. The restarted real child reports a dirty document through both the Bridge
   snapshot and the public `document.isDirty` model. The fixture records one
   restored file-backed dirty document; no DOM injection, `eval()`, or
   OpenVSCode fork is involved.

4. Before native close, the same finite run drives a lifecycle audit through a
   host-only control file: it records the initial visible shell dimensions and
   child bounds, hides and shows the same `folder-one` child, focuses
   `folder-two` and records Tauri focus plus AppKit key-window/first-responder
   state, then requests a distinct native resize and records the resulting
   `WindowEvent::Resized` and child `set_bounds` updates. The page-load count
   and surface identities are compared before/after, and the Bridge ready /
   dirty state is checked after the sequence. These are public Tauri/AppKit
   operations; no DOM or page JavaScript is used.

The latest recorded run is `20260822`. Its ledger is
`evidence/f02-ledger-20260822.ndjson`; the matching bridge, server, host, and
command logs are `f02-*-20260822.*`. The ledger records all targeted assertions
as `PROVEN`, including cross-child global/workspace storage, hot exit after a
native host restart, same-server survival, and zero listeners after cleanup.

## Optional hidden continuity helper

This helper is separate from the hot-exit runner and must be run while the
host's deterministic `REAL_WORKBENCH_AUTO_HIDE_LABEL=folder-one` hook is active:

```sh
REAL_WORKBENCH_CONTINUITY_SECONDS=90 \
REAL_WORKBENCH_CONTINUITY_INTERVAL_SECONDS=15 \
scripts/continuity-check.sh
```

The required 600-second run completed on 2026-08-22; every sample retained the
management and extension-host sockets and the host log had no later page-load.
See the existing `f02-continuity-20260822.log` and
`f02-process-{start,mid,end}-20260822.log` records.

## Safety and cleanup

The server binds only to `127.0.0.1` and its token file is mode `0600`. Query
strings and bearer values are redacted before logs are persisted. The runner
terminates only its own process groups, closes the Bridge listener, checks both
the OpenVSCode and Bridge ports with `lsof`, and removes its generated runtime.
If a manual run is interrupted, stop the host and server, verify
`lsof -nP -iTCP:<port> -sTCP:LISTEN` is empty, then remove only that run's
explicit `/private/tmp` directory.

This is not an app bundle and makes no keyboard, Japanese IME, release, or
production-acceptance claim. See [`PROTOTYPE-RESULTS.md`](PROTOTYPE-RESULTS.md)
for the full evidence matrix and remaining Wave 0 gates.
