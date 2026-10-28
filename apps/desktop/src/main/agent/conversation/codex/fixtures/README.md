# Codex app-server fixtures

**Every file here is hand-written, not captured.** Each is what `codex app-server`
would print to stdout — one JSON-RPC message per line — written by hand from the
vendored protocol types in `../protocol/` (openai/codex `rust-v0.156.1`, and
`rust-v0.158.0` for the one file that says so). The
Homebrew `codex` on the machine they were written on could not run, so none of
this has been checked against a real app-server yet. The `.handwritten.ndjson`
suffix says so wherever a file is referenced.

Design §8 stage 0 captures the real thing. Captured files go next to these without
the `.handwritten` part, scrubbed the same way these are written: paths under
`/home/testuser`, accounts `alice@example.com`, dummy UUIDs.

- `handshake.handwritten.ndjson` — the replies to `initialize`, `account/read`,
  `thread/start` (and its `thread/started`), `model/list` and `skills/list`, in
  that order, to requests `0` to `4`.
- `turn.handwritten.ndjson` — one turn started by request `5`: a user message,
  reasoning, a streamed reply, a command that asks for approval (server request
  `0`), a file change that asks for approval (server request `1`), a plan, token
  usage, a rate limit, and the end of the turn.
- `subagent.handwritten.ndjson` — one turn started by request `5` in which the
  main thread spawns a subagent, the subagent's own thread says something and
  runs a command, and the main thread waits for it and reports.
- `subagent-v2.handwritten.ndjson` — the same under multi-agent v2, which
  codex-cli 0.158.0 runs, written from upstream's `rust-v0.158.0` sources
  (`core/src/tools/handlers/multi_agents_v2/`, `core/src/agent/control/`):
  each spawn is a `subAgentActivity` `started` item named by the call's id,
  with no `collabAgentToolCall`, emitted only once the subagent's thread is
  running, so one subagent's thread speaks before its call is reported and
  the other's after. The first ends its turn and is reported `completed`; the
  second's turn fails, which upstream reports with no activity item.

- `resume.handwritten.ndjson` — the handshake of a conversation that resumes
  thread `…0a` (`thread/resume` is request `2`), written from upstream's
  `rust-v0.165.0` sources (`app-server/src/request_processors/thread_processor.rs`,
  `thread_lifecycle.rs`, `app-server-protocol/src/protocol/thread_history.rs`):
  the deprecation notice 0.158+ sends before it hydrates a paginated thread's
  whole history, a history of a completed turn (with a web page opened, an
  image generated, a sleep, and a status and a collab tool 0.165 does not
  name), a turn the usage limit failed, a turn its server never ended
  (reported `interrupted`, as `set_thread_status_and_interrupt_stale_turns`
  does), a turn of a status 0.165 does not name and one DevHub cannot read,
  then `thread/status/changed`, `thread/readState/changed` and
  `thread/prediction/updated`.
- `rate-limit.handwritten.ndjson` — one turn started by request `5` that the
  plan's usage limit ends, written from the same sources
  (`app-server/src/bespoke_event_handling.rs`): a command that keeps running,
  a 429 the stream retries (`error`, `willRetry: true`), a second command
  waiting on an approval (server request `0`, which Codex drops with the
  turn and never resolves), the rate limits used up, the usage-limit `error`
  that is not retried, output from the first command after it, the turn's
  `turn/completed` (`failed`), the command's result after the turn, and a
  delta for a message that never started.

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
