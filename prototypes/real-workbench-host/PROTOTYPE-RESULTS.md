# THROWAWAY results: real OpenVSCode Workbench host

Date: 2026-08-22 (Asia/Tokyo)  
Evidence run: `20260822`  
Ledger: `evidence/f02-ledger-20260822.ndjson`

The strict lifecycle audit is invoked explicitly with
`scripts/run-f02-lifecycle-evidence.mjs`; it writes the same canonical ledger
as the full runner with mode `lifecycle-audit`.

## Decision

**F0.2 prototype evidence is complete for the requested topology, shared
storage, hot exit, and cleanup assertions.** The pinned upstream Workbench
rendered as one folderless and two folder child WKWebViews in one native host.
The finite runner measured public-API cross-child storage, created a real dirty
file-backed editor, closed and relaunched the native host while keeping the
same OpenVSCode server/origin alive, and observed the dirty document restored in
the new child through both Bridge snapshot and `document.isDirty`.

This remains a feasibility record, not production acceptance. Keyboard routing,
Japanese IME, app packaging, and the other Wave 0 gates remain outside this
prototype.

## Pins and environment

| Item | Value |
|---|---|
| macOS | Tahoe 26.5, build 25F71 |
| Machine | arm64 |
| Rust/cargo | **1.97.1** (`rust-toolchain.toml`) |
| OpenVSCode tag | `openvscode-server-v1.109.5` |
| OpenVSCode commit | `4ffe2270acdf711bbefecc3e8c79f4b3631640e5` |
| OpenVSCode source | `/private/tmp/openvscode-darwin-arm64-feasibility/source` (clean, unchanged) |
| Darwin artifact | `/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64` |
| Embedded Node | 22.21.1 Darwin arm64 |
| Tauri | 2.11.5 |
| WRY host dependency | 0.55.1 API, existing throwaway vendor tree |
| WebKit data store | one shared root and `DEVHUB-WB-STORE1` identifier for all children |
| Server profile | one `--user-data-dir`, one `--server-data-dir`, one `--extensions-dir` for both host phases |

The artifact's `openvscode-server --help` succeeds and the executable is the
Darwin arm64 artifact used by the runner. The server binds only to an explicit
`127.0.0.1` address and uses a generated mode-600 connection-token file.

## Exact commands and results

```sh
cd ~/path/to/devhub/prototypes/real-workbench-host
rustc --version
# rustc 1.97.1 (8bab26f4f 2026-07-14)
cargo fmt -- --check
# PASS
cargo check --offline
# PASS; existing WRY deprecation/unsafe warnings only
cargo test --offline
# PASS; 0 tests
node scripts/run-f02-evidence.mjs
# exit 0; ledger below
```

The runner also packages and installs the independent fixture VSIX, so the
real child extension is not a mock page or DOM injection. The exact redacted
outputs are kept in:

- `evidence/f02-commands-20260822.log`;
- `evidence/f02-bridge-20260822.log`;
- `evidence/f02-server-prepare-20260822.log` and
  `evidence/f02-server-restore-20260822.log`;
- `evidence/f02-host-prepare-20260822.log` and
  `evidence/f02-host-restore-20260822.log`.

## F0.2 evidence ledger

| Assertion | Result | Evidence |
|---|---|---|
| pinned toolchain host build | **PROVEN** | `cargo build --offline`, pinned `rust-toolchain.toml` |
| owner-only connection token | **PROVEN** | mode `0600` check in runner |
| two real child Bridge identities | **PROVEN** | 3 authenticated identities (Global, Workspace A, Workspace B) |
| cross-child global state | **PROVEN** | A writes `ExtensionContext.globalState`; B reads matching value |
| workspace state is scoped | **PROVEN** | B reports A's `workspaceState` key absent |
| real dirty editor created | **PROVEN** | public `workspace.fs` + `openTextDocument` + `TextEditor.edit`; Bridge dirty event |
| hot-exit backup dwell | **PROVEN** | dirty state held for 8 seconds before close |
| native close (prepare) | **PROVEN** | host `CloseRequested` and `Destroyed`, exit 0 |
| server survives native window close | **PROVEN** | same server PID and loopback port `54945` after close |
| hot-exit restore after native restart | **PROVEN** | restored marker: `dirty=true`, `dirty_documents=1`; Bridge snapshot dirty=true |
| native close (restore) | **PROVEN** | host `CloseRequested` and `Destroyed`, exit 0 |
| initial native visibility/dimensions | **PROVEN** | host `host_state` plus all three child `host_child_state` records (`3024x1750`) |
| hide same child | **PROVEN** | native Tauri `Webview::hide`, `folder-one` visible=false |
| show same child | **PROVEN** | native Tauri `Webview::show`, same `folder-one` visible=true |
| page-load identity unchanged | **PROVEN** | page-load count and surface identities unchanged across lifecycle actions |
| native focus/key-window/first-responder restoration | **PROVEN** | selected `folder-two`; Tauri focus and AppKit key/first-responder audit |
| native resize event and child bounds update | **PROVEN** | `3024x1750` → `3520x1750`, `WindowEvent::Resized`, and post-resize `set_bounds` |
| Bridge ready/dirty continuity across lifecycle | **PROVEN** | ready snapshot and dirty state retained after hide/show/focus/resize |
| authenticated real Workbench child | **PROVEN** | authenticated loopback Bridge; no DOM/eval/fork |
| finite process/port/temp cleanup | **PROVEN** | OpenVSCode and Bridge ports `54945`, `54946` both listener-free; runtime removed |

The native host was relaunched against the same authenticated URL origin and
the same persistent WebKit root/data-store identifier. No server restart or
port change occurred between the close and restore phases. The restore marker
is consumed through `vscode.workspace.fs`; it only disambiguates a real host
relaunch from an extension-host reconnect during the prepare dwell.

## Existing topology/continuity evidence

The earlier 600-second hidden-child run remains valid and is retained rather
than duplicated:

| Gate | Result | Evidence / limitation |
|---|---|---|
| authenticated Global/folder URLs | **PROVEN** | `f02-smoke-20260822.log`, three HTTP 200 responses and unauthenticated 403 |
| separate folder identity | **PROVEN** | distinct upstream folder URLs and Bridge contexts |
| shared WebKit configuration | **PROVEN** | same data root and `DEVHUB-WB-STORE1` in host log |
| background throttling disabled | **PROVEN** | explicit host builder policy for every child |
| native hide/show and resize | **PROVEN** | current finite lifecycle audit records visibility transitions, native resize event, child bounds, and no reload |
| hidden 600-second socket continuity | **PROVEN** | `f02-continuity-20260822.log` |
| hidden process survival/no reload | **PROVEN** | `f02-process-{start,mid,end}-20260822.log`, `f02-host-20260822.log` |
| clean bounded shutdown | **PROVEN** | `f02-shutdown-20260822.log` |

## Not claimed by this prototype

| Gate | Result | Reason |
|---|---|---|
| Cmd+P/Cmd+Shift+P/Cmd+S/Cmd+Z/Cmd+C/V native routing | **BLOCKED** | no trusted NSEvent-to-child assertion in this harness |
| DevHub Command+Q prefix | **BLOCKED** | native key router belongs to F0.3 |
| Japanese IME | **BLOCKED** | requires the dedicated native IME harness |
| app bundle/signing/macOS hosted CI | **BLOCKED** | outside this throwaway host |
| production hot-exit acceptance | **PARTIAL** | this is one finite real fixture run, not the full scale/endurance matrix |

No OpenVSCode file was changed. No content, credentials, token, or query value
is emitted in evidence logs. The optional upstream `vsda` web files remain
missing in the artifact's stderr but did not prevent the real Workbench or
Bridge/storage/hot-exit assertions from completing.

## Recommendation

Carry forward the upstream OpenVSCode pin and the host-only child-WebView
topology. Carry forward the lifecycle rule demonstrated here: closing the
native Workbench window must leave the authenticated server, profile, and
provider state alive; reconstruction reuses the same origin and WebKit store.
Before production implementation, run the separate F0.3 native keyboard/IME
gate and the agreed scale/endurance matrix. Do not fork OpenVSCode for either
remaining concern.
