# F0.5 runtime execution results

## Herdr execution result

Run date: 2026-08-22 (local macOS host)

Command:

```sh
python3 prototypes/runtime-feasibility/scripts/herdr_feasibility.py \
  --run-dir prototypes/runtime-feasibility/evidence/herdr-run-final
```

The harness used the installed Herdr `0.8.1` endpoint (protocol `20`) with
three concurrent interactive clients and the isolated named session
`devhub-session`. It used a temporary `XDG_CONFIG_HOME` and Unix socket under
`/private/tmp`; the user's existing Herdr server was not addressed. Provider
configuration was isolated with temporary `CLAUDE_CONFIG_DIR` and `CODEX_HOME`,
all known credential-bearing environment variables were scrubbed, and no task
prompt was sent. Claude's documented `auth status --json` check returned
`loggedIn=false`, `authMethod=none`, and `apiProvider=firstParty`; only those
content-free fields were retained. Both real provider panes still returned
`agent_started`, `idle`, and `interactive_ready`, proving that readiness alone
does not imply authentication. The system Homebrew Codex shim was bypassed
only inside the temporary PATH with a symlink to the installed ChatGPT bundle
binary; neither the Homebrew shim nor the application bundle was modified.

The machine-readable evidence is
[`evidence/herdr-run-final/herdr-results.json`](evidence/herdr-run-final/herdr-results.json).

| Check | Result | Evidence |
| --- | --- | --- |
| Herdr version/protocol | PASS | `0.8.1`, protocol `20` |
| Bootstrap race | PASS | three concurrent clients; isolated socket ready |
| Protocol/capability gate | PASS | snapshot and schema protocol `20`; required lifecycle/event methods present |
| Intentional mismatch gate | PASS | incompatible expected protocol is rejected before mutation; no mismatched binary was installed |
| Codex/Claude profile validation | PASS | supported profiles accepted; arbitrary kind and invalid env name rejected |
| Real Codex + Claude launch/readiness | PASS | Herdr launched both real panes; both reported `interactive_ready=true` |
| Claude auth state | PASS (state) | `claude auth status --json`: `unauthenticated`, `loggedIn=false`, `authMethod=none`; status is separate from readiness |
| Subscribe/buffer/snapshot reconciliation | PASS | direct persistent Unix stream receives real `workspace_created`/`pane_created` envelopes after direct API mutation; authoritative snapshot is read through a separate control connection because the subscribed stream is push-only |
| Controller detach/reconnect/conditional takeover | PASS | real attach/reconnect observed; takeover mutation was not sent while live surface count was `1`, allowed after detach |
| Provider-initiated exit contract | PASS (generic) / BLOCKED (Claude sub-capability) | Claude 2.1.239 remains agent/process-present after `/exit`, `/quit`, Ctrl-D, and Ctrl-C (no disappearance during the bounded `32,915 ms` attempt window); Codex agent/process disappears after `/quit` (`8,657 ms` in this run). Claude is recorded as nonblocking credentialed acceptance debt |
| Controller signal contract | PASS | isolated foreground process groups receive SIGINT and SIGTERM; disappearance is recorded as controller action, never natural exit |
| Herdr `pane.release_agent` | PASS (non-termination) | API returns `ok`, while Claude agent and provider process remain present; explicit close follows |
| DevHub explicit `pane.close` cleanup | PASS | every real probe pane closes; repeated close returns not-found and pane absence is verified |
| Idempotent terminate/tombstone retry | PASS | real pane close, repeated close, residual check, and prototype tombstone completion |

Top-level `herdr-results.json` status is `pass` with explicit
`acceptance_debt=["herdr-natural-exit-latency"]` (raw evidence: 10 PASS, 1
BLOCKED, 0 FAIL). The blocked raw substatus is nonblocking because the real
Claude pane is proven unauthenticated and the generic natural reconciliation
contract is proven by Codex; the result does not claim Claude natural exit
passed. Cleanup assertions show `provider_residual_agents=0`,
`provider_residual_probe_panes=0`, isolated server stopped, socket removed, and
temporary root removed. Provider-level authentication/exit limitations and
the push-only stream boundary are explicit hard-gate notes, not fake-adapter
PASSes; terminal/provider credentials, terminal frames, and task content were
not persisted. The
tombstone persistence row includes a
clearly labeled prototype model because the production StateStore does not
exist yet.

This is a feasibility gate, not production implementation. Production must
preserve the push-only subscription/control-connection split, model provider
initiated exit separately from DevHub explicit stop/signals, and rerun the
Claude natural-exit acceptance scenario with credentials before claiming that
provider-specific behavior. The finite rerun command writes the complete
machine-readable result; it exits nonzero only for hard-gate blockers, while a
nonblocking provider debt remains visible in `summary.acceptance_debt`.

## tmux execution result

Run date: 2026-08-22 (local macOS host)

Command:

```sh
python3 prototypes/runtime-feasibility/scripts/tmux_feasibility.py \
  --run-dir prototypes/runtime-feasibility/evidence/tmux-run-real
```

Runtime observed:

| Check | Result |
| --- | --- |
| Installed tmux | `3.7b` |
| Socket | temporary `-L devhub` server |
| Marker and metadata | PASS |
| Deterministic workspace session | PASS (`ws-` + first 20 SHA-256 hex chars) |
| External attach/detach | PASS |
| Missing-session recreation | PASS |
| Pane process/busy inspection | PASS (`sleep` PID and `pane_dead=0`) |
| Unknown-session nonownership | PASS (`foreign-session` survived owned cleanup) |
| Idempotent owned cleanup | PASS |
| Socket preflight | PASS (absent, wrong marker, marked target, unknown-only target) |
| Transition crash-state persistence | PASS (`pending` through `stable`) |

The machine-readable evidence is
[`evidence/tmux-run-real/tmux-results.json`](evidence/tmux-run-real/tmux-results.json).

Cleanup assertions in that result show zero sessions on every temporary
server, removal of the temporary `TMUX_TMPDIR`, and an unchanged ordinary-user
tmux session list. The harness has no fake-adapter pass path and touched no
production file.

This is a feasibility gate, not production implementation. Production must
still implement the ownership, busy-inspection, and resumable socket-transition
contracts in `docs/IDENTITY-AND-LIFECYCLE.md` and `docs/CONFIGURATION.md`.
