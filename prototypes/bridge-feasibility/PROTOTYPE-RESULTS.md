# F0.4 Bridge feasibility results

## Verdict

The narrow bridge transport and real Workbench URL/new-window boundary are
feasible with OpenVSCode 1.109.5 and no fork. The hard gate is **PASS**:
both required boundary interceptions were observed in the real Tauri child
WebView. The strict extension-host restart proof is also **PASS** for this
feasibility prototype: the isolated server-owned extension-host children
exited, a different child respawned, and the extension reconnected as a new
activation without Workbench navigation.

The real run used the pinned `1.109.5` artifact, a VSIX installed into an
isolated `--extensions-dir`, a pre-scan with `--list-extensions`, and a fresh
Workbench connection after the scan. The extension was therefore discovered
and activated by the actual remote extension host rather than by a mock.

The strict-audit rerun probes `vscode.commands.getCommands(true)` for a
public extension-host restart command, then (only after generation-2
endpoint-loss reconnect) controls the isolated server's direct
`--type=extensionHost` child lifecycle. It requires PID exit, a different
owned child PID respawn, and a new stable extension activation identity before
the dirty fixture is created.

## Evidence ledger

| Capability | Result | Evidence/meaning |
| --- | --- | --- |
| Pinned OpenVSCode 1.109.5 | PASS | `evidence/real-smoke.ndjson`, `openvscode_ready` |
| Bearer upgrade auth | PASS | `evidence/protocol-tests.ndjson`; wrong token rejected, valid token accepted |
| `hello` → `accepted` → `snapshot` | PASS | `evidence/real-host.ndjson` and protocol suite |
| Surface identity binding | PASS | `evidence/protocol-tests.ndjson`, `invalid_identity` |
| Readiness | PASS | real snapshot contains `ready` |
| Aggregate dirty state | PASS | two untitled content documents made dirty through public `vscode.workspace.openTextDocument({content})` + `showTextDocument`; aggregate true is recorded |
| Folder/open-workspace request | PASS | `open_workspace_requested` in real host evidence |
| New-window request | PASS | `new_window_requested` in real host evidence |
| Folder navigation interception | PASS | public Tauri `on_navigation` callback emitted `folder_navigation_intercepted` and cancelled the navigation |
| New-window interception | PASS | public Tauri `on_new_window` callback emitted `new_window_intercepted` and returned `Deny` |
| Endpoint loss | PASS | first connection is intentionally closed after its first snapshot; `endpoint_loss_injected` and `connection_closed` are recorded |
| Extension reconnect | PASS | second `hello`/snapshot has a later connection generation |
| Extension-host restart | PASS | owned server PID `48641` children `48721`, `48723` exited on SIGTERM; child `48779` respawned; generation 3 hello/snapshot used a new stable extension activation identity |
| Ordering/dedup/error | PASS | protocol suite covers sequence gaps, duplicate request IDs, invalid identity, and request responses |
| **Hard gate** | **PASS** | both folder and new-window boundary results are PASS |

`evidence/real-smoke.ndjson` is the canonical latest run ledger. The final
result row is:

```json
{"pinned_openvscode":"PASS","bearer_upgrade_auth":"PASS","hello_accepted_snapshot":"PASS","readiness":"PASS","endpoint_loss":"PASS","reconnect":"PASS","extension_host_restart":"PASS","dirty_aggregate":"PASS","open_workspace_request":"PASS","new_window_request":"PASS","folder_interception_boundary":"PASS","new_window_interception_boundary":"PASS","hard_gate":"PASS"}
```

## Important interpretation

The public command probe is evidence about the browser Workbench API; the
controlled child lifecycle is a feasibility-only host operation, scoped to the
isolated pinned server and guarded by server PID, port, artifact path, and
`--type=extensionHost`. It is not a production restart API. A real
endpoint-loss reconnect is proven separately. The dirty fixture is scheduled
after the restart, so no dirty confirmation is needed to prove the
extension-host lifecycle. Generation 1 and 2 retain the same stable
activation identity; generation 3 uses a new one.

The folder and new-window results are host-boundary results, not claims that a
public VS Code extension API can cancel those operations. The extension emits
the public command/request path; the Tauri child WebView owns interception at
the host URL/new-window boundary allowed by ADR 0014. No OpenVSCode source was
modified.

## Verification commands and artifacts

- `zsh scripts/build-vsix.sh` — VSIX packaging PASS.
- `cargo check --offline --manifest-path host-harness/Cargo.toml` — host
  compile/check PASS. The real smoke also runs an offline `cargo build`.
- `node scripts/protocol-tests.mjs` — deterministic protocol/state PASS.
- `node scripts/real-smoke.mjs` — real Workbench run; latest hard gate PASS.
- `schema/bridge-v1.schema.json`, `fixtures/valid.ndjson`, and
  `fixtures/invalid.ndjson` — prototype-only schema/fixtures.
- `evidence/protocol-tests.ndjson` and `evidence/protocol-host.ndjson` —
  transport/state evidence.
- `evidence/real-smoke.ndjson`, `evidence/real-host.ndjson`,
  `evidence/real-host-harness.log`, and `evidence/real-openvscode-server.log`
  — redacted real-run evidence. The latter contains no bearer token.
- `evidence/cleanup-check.ndjson` — post-run targeted process/listener check;
  unrelated services are identified and excluded.

## Cleanup

The real smoke is finite and attempts to terminate its Tauri/OpenVSCode
children. After the final run, stale F0.4 server/host processes were checked
and targeted termination was performed; unrelated repository services were
left running. No GUI process or F0.4 listener should be left running when the
prototype is handed off.
