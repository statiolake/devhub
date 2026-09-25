# Codex app-server fixtures

**Every file here is hand-written, not captured.** Each is what `codex app-server`
would print to stdout — one JSON-RPC message per line — written by hand from the
vendored protocol types in `../protocol/` (openai/codex `rust-v0.156.1`). The
Homebrew `codex` on the machine they were written on could not run, so none of
this has been checked against a real app-server yet. The `.handwritten.ndjson`
suffix says so wherever a file is referenced.

Design §8 stage 0 captures the real thing. Captured files go next to these without
the `.handwritten` part, scrubbed the same way these are written: paths under
`/home/testuser`, accounts `alice@example.com`, dummy UUIDs.

- `handshake.handwritten.ndjson` — the replies to `initialize`, `account/read`,
  `thread/start` (and its `thread/started`) and `model/list`, in that order, to
  requests `0` to `3`.
- `turn.handwritten.ndjson` — one turn started by request `4`: a user message,
  reasoning, a streamed reply, a command that asks for approval (server request
  `0`), a file change that asks for approval (server request `1`), a plan, token
  usage, a rate limit, and the end of the turn.
- `subagent.handwritten.ndjson` — one turn started by request `4` in which the
  main thread spawns a subagent, the subagent's own thread says something and
  runs a command, and the main thread waits for it and reports.

Two orderings in these files are assumptions stage 0 has to confirm: that a
command's `item/started` comes before its approval request (upstream's
`bespoke_event_handling.rs` does it that way at this tag), and that a subagent's
`thread/started` and items arrive on the same connection after the `spawnAgent`
call that names it.

## Captures

Two files here are scrubbed real captures (their headers say how each was
made), in the `> ` / `< ` form: `> ` is a line DevHub wrote, `< ` one
app-server printed, interleaved at the offsets DevHub's `in.log` recorded.

- `signed-out.capture.ndjson` — codex-cli 0.156.1 with an empty `CODEX_HOME`:
  the handshake of an app-server that is not signed in. No prompt.
- `codex-greeting.capture.ndjson` — the owner's signed-in app-server, one
  greeting turn (gpt-6-luna, effort low, read-only sandbox).

Approvals, file changes and subagents are still only in the hand-written files.
