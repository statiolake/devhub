# F0.4 Bridge feasibility prototype

This directory is a throwaway Wave 0 F0.4 experiment. It answers one
question: can a narrow, public-API-only VS Code extension bridge communicate
with a loopback host and can the host own the folder/new-window boundary in a
real OpenVSCode 1.109.5 Workbench?

The prototype does not change OpenVSCode or production code. The extension
uses only public `vscode.workspace`, `vscode.window`, `vscode.commands`, and
document events. Its loopback transport is a small dependency-free RFC6455
client with mandatory `Authorization: Bearer ...` upgrade authentication. The
Tauri host harness uses public WebView navigation/new-window callbacks and
cancels folder navigation or denies new windows at that boundary.

## Run

Run from the repository root:

```sh
cd ~/path/to/devhub/prototypes/bridge-feasibility
zsh scripts/build-vsix.sh
cargo check --offline --manifest-path host-harness/Cargo.toml
node scripts/protocol-tests.mjs
node scripts/real-smoke.mjs
```

`protocol-tests.mjs` is loopback-only. `real-smoke.mjs` additionally needs
the pinned OpenVSCode 1.109.5 artifact at
`OPENVSCODE_ARTIFACT_ROOT` (or the default path in the script), a GUI-capable
Tauri runtime, and permission to bind loopback sockets. Both test suites have
finite timeouts. The real smoke exits non-zero when either hard-gate boundary
is not observed.

## Layout

- `extension/` — minimal VSIX source and manifest (`extensionKind: workspace`,
  Node `main`, `activationEvents: ["*"]`).
- `host/bridge-host.mjs` — strict v1 envelope validator, WebSocket upgrade
  host, identity/sequence/dedup/request ledger, and aggregate dirty state.
- `host-harness/` — Tauri 2.11.5 child-WebView harness for the real URL and
  new-window boundary.
- `schema/bridge-v1.schema.json` — prototype wire-envelope schema.
- `fixtures/` — valid and invalid envelope examples.
- `scripts/protocol-tests.mjs` — deterministic transport/state tests.
- `scripts/real-smoke.mjs` — pinned real-Workbench smoke and evidence writer.
- `evidence/` — redacted NDJSON/log output from the latest runs, including
  `cleanup-check.ndjson`.
- `PROTOTYPE-RESULTS.md` — verdict ledger and limitations.

## Scope and security notes

The endpoint is restricted to loopback and the upgrade requires the exact
Bearer token. Surface identity is bound at `hello` and checked on later
messages. Tokens are generated per run and redacted in committed server
diagnostics. This is a feasibility harness, not a production WebSocket
implementation or an extension suitable for distribution.

The restart probe is deliberately separate from Workbench reload. After the
first endpoint-loss reconnect, the smoke finds only direct children of its
isolated OpenVSCode server whose command is the pinned artifact's
`--type=extensionHost`, sends those children `SIGTERM`, and requires each PID
to disappear before a different owned child PID respawns. No DOM injection,
Workbench navigation, private VS Code command, or unrelated process is used.
