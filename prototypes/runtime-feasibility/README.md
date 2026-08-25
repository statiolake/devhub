# F0.5 runtime feasibility

This prototype contains the tmux and Herdr halves of Wave 0 F0.5. Both probes
talk to the installed runtimes directly and do not import production code.

## Herdr probe

Run the real Herdr probe with:

```sh
python3 prototypes/runtime-feasibility/scripts/herdr_feasibility.py \
  --run-dir prototypes/runtime-feasibility/evidence/herdr-run-final
```

It starts exactly the named `devhub-session` behind a short-lived isolated
`XDG_CONFIG_HOME`; the resulting Herdr Unix socket is under `/private/tmp` so
macOS' AF_UNIX pathname limit cannot turn path length into a false result. The
user's running/default Herdr server is never addressed. `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` are also isolated and no task prompt is sent. If the system
Homebrew Codex shim is unusable, the harness creates a temporary symlink to
`/Applications/ChatGPT.app/Contents/Resources/codex` in its own PATH prefix;
the installed application is not modified.

The final checked-in Herdr evidence is
`evidence/herdr-run-final/herdr-results.json`.

The real run PASSes Herdr `0.8.1`/protocol `20` bootstrap race (three clients),
capability/protocol gate, Codex/Claude profile validation and launch, and
controller detach/reconnect with a conditional takeover gate. Claude
authentication is checked with its documented read-only `claude auth status
--json` command in an isolated `CLAUDE_CONFIG_DIR`; only the
`authenticated`/`unauthenticated` verdict, provider, and method are retained.
Herdr's `interactive_ready=true` is recorded separately because it does not
mean the provider is authenticated.

The direct Unix socket probe keeps the `events.subscribe` connection open as a
push-only stream, observes real `workspace_created`/`pane_created` envelopes
after a real API mutation, and reconciles against an authoritative snapshot
through a separate control connection. Herdr correctly closes the stream if an
ordinary request is sent on it; that protocol boundary is recorded rather than
hidden.

Exit evidence is a ledger, not one aggregate PASS: `/exit`, `/quit`, Ctrl-D,
and Ctrl-C are sent to the real provider pane before any close. The run also
measures foreground provider-process disappearance, isolated SIGINT/SIGTERM,
and Herdr's public `pane.release_agent` API. A provider-initiated exit is
reported only when both the Herdr agent record and provider process disappear;
`pane.close` is always recorded as DevHub explicit stop, with repeated close
and pane absence proving idempotency. On the reference run Claude 2.1.239 is
unauthenticated and remains present for all input methods, so its
provider-initiated exit sub-capability is recorded as `blocked` acceptance
debt; generic natural reconciliation is proven by Codex and all explicit
cleanup passes. The top-level F0.5 release-gate summary is therefore `pass`
with that debt listed explicitly. No fallback is promoted to natural-exit
evidence.

The harness uses:

- tmux `3.7b` (MVP minimum `3.3`);
- configured socket name `devhub` via `tmux -L devhub`;
- an automatically-created short `TMUX_TMPDIR` under `/private/tmp` so the
  macOS Unix-socket pathname limit cannot accidentally select the user's
  socket;
- a temporary workspace root and dedicated server; and
- normal user tmux configuration (no `-f /dev/null`).

The ordinary user tmux server is inspected read-only before and after the run.
No command using the ordinary socket can mutate, attach to, or kill it.

## Run

From the repository root:

```sh
python3 prototypes/runtime-feasibility/scripts/tmux_feasibility.py
```

The command writes a durable, content-free result to
`prototypes/runtime-feasibility/evidence/tmux-run-<timestamp>/tmux-results.json`.
The most recent checked-in execution is in
`evidence/tmux-run-real/tmux-results.json`.

Pure harness checks run with:

```sh
python3 -m unittest discover -s prototypes/runtime-feasibility/tests -v
```

## Coverage

The real-binary run covers marker and session metadata, deterministic
`ws-<sha256-prefix>` naming, external attach/detach, missing-session
recreation, pane PID/command/dead-state inspection, a running `sleep` busy
pane, unknown-session nonownership, repeated owned-session cleanup, and target
socket preflight. Preflight cases include an absent target, a wrong marker, a
correctly marked target containing an owned session, and a correctly marked
target containing only an unknown session. Persist/reload checks cover the
`pending`, `cleaning-old`, `old-cleaned`, `recreation-pending`, and `stable`
socket-transition crash states.

`tmux-results.json` records each result as `pass`/`fail`, the exact temporary
socket name, metadata observed, process inspection, unknown-session survival,
and cleanup evidence. Provider or adapter fakes are not used as a pass path.

`herdr-results.json` records `pass`/`blocked` outcomes, a top-level `status`
and `summary` that explicitly distinguish hard-gate blockers from nonblocking
provider-specific acceptance debt, content-free auth state, real provider
launch identity (including the effective Codex bundle symlink), persistent
stream and control-connection reconciliation, pane-feed exit operations,
process/agent disappearance, signals, lifecycle API results, snapshot
protocol, capabilities, controller gate state, and residual cleanup.
Terminal/provider frames are consumed only for readiness and bounded
structural diagnostics; they are not written to evidence. The probe sends no
task prompt.

## Cleanup evidence

At the end of the checked-in run:

- all temporary named servers had zero sessions;
- the temporary `TMUX_TMPDIR` was removed;
- the intentionally unknown `foreign-session` survived owned-resource cleanup
  and was removed only when the temporary server itself was finally stopped;
- the ordinary socket's session list was unchanged; and
- no production files were touched.

The process inspection result is evidence for the runtime contract only. It is
not a production implementation of busy inspection or the StateStore
transition machine; those modules must implement the normative contracts in
`docs/IDENTITY-AND-LIFECYCLE.md` and `docs/CONFIGURATION.md`.

The Herdr probe is likewise evidence, not the production `AgentRuntime`. The
provider-level Claude authentication/exit debt and the push-only API stream
boundary remain explicit acceptance notes even though generic reconciliation,
signals, explicit cleanup, and real-Codex natural-exit checks PASS.
