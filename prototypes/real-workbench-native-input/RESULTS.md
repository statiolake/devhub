# F0.2/F0.3 real Workbench gate results

Date: 2026-08-22 (Asia/Tokyo)

## Decision

The real authenticated OpenVSCode 1.109.5 child topology is usable for the
native-input feasibility gate. Exact double-Command-Q routing and Japanese
TIS/CGEvent IME commit are **PASS**. Ordinary shortcut posts and the real
Workbench P/Shift-P UI are **PASS**. C/V/Z editor mutation and clipboard
observation remain **NOT PROVEN**; no synthetic substitute is promoted to a
PASS.

## Static checks

| Check | Result |
|---|---|
| `cargo fmt -- --check` | PASS |
| `cargo check --offline` | PASS (only existing WRY deprecation/unsafe warnings) |
| `cargo test --offline` | PASS (5 router tests) |
| VSIX zip/build and Node syntax checks | PASS |
| no executable DOM/JS injection path | PASS; see `evidence/contract-tests.txt` |

## Runtime matrix

| Gate | Result | Observable evidence / limitation |
|---|---|---|
| Real authenticated Workbench child | PASS | Host `child_create`/`page_load` logs identify `upstream_pinned_1.109.5`; server uses the pinned artifact and one folder workspace. |
| Cmd-P through Workbench | PASS | `CGEventPostToPid` post + real Workbench Quick Open screenshot. |
| Cmd-Shift-P through Workbench | PASS | `CGEventPostToPid` post + real Workbench Command Palette screenshot. |
| Cmd-S/Z/C/V posts | PASS (posts only) | Every requested key is recorded by the native monitor as an ordinary pass. |
| C/V/Z editor mutation and clipboard | **NOT PROVEN** | Public Bridge runs completed without the required native-paste/undo text transition; `clipboard_after_cmd_c` is intentionally not promoted. |
| Public Workbench editor state | PASS | Extension reports fixture URI, text, selection, dirty/save state through public VS Code API. |
| First exact Command-Q | PASS | Host log explicitly records `workbench_received=false`; first event is consumed. |
| Second exact Command-Q | PASS | One `AppKit_NSEvent`, `synthetic_js=false`; one public `devhub.realNativeInput.q` result. |
| TIS main-thread selection | PASS | `querying TIS on main thread`, selected Japanese source, and native roman-key records. |
| Japanese IME commit `にほんご` | PASS | Public Bridge sees intermediate composition, `document_changed` text `にほんご`, dirty `true`, then `document_saved` dirty `false`. |
| Input-source restoration | PASS | `restored_match=true`, status `0`, original source ID restored. |
| Finite cleanup | PASS | Latest run records host/server stop, bridge close, and `listener_zero=true`. |
| No OpenVSCode source/production change | PASS | Source/artifact are external; this directory contains only the throwaway host. |

## Retained run references

The generated files are ignored by design. The clean final runs used for this
matrix were:

```text
evidence/native-workbench-normal-23587-1787408218666.ndjson
evidence/native-workbench-normal-23587-1787408218666.host.log
evidence/native-workbench-normal-23587-1787408218666.bridge.ndjson
evidence/native-workbench-ime-24270-1787408276446.ndjson
evidence/native-workbench-ime-24270-1787408276446.host.log
evidence/native-workbench-ime-24270-1787408276446.bridge.ndjson
```

The corresponding screenshot directories contain the real Quick Open and
Command Palette checkpoints. Do not copy tokens into the repository.

## Remaining gate

The only deliberately open item in this cross-gate is native edit-result
proof for Command-C/V/Z (and a dirty transition caused by those keys). The
runner still posts and logs all requested events, and it does not claim that
the editor changed merely because a CGEvent was sent. A future iteration must
find a public, accessibility-independent Workbench state oracle for that
native edit path or leave the item **NOT PROVEN**.
