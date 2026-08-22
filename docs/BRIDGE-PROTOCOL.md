# DevHub Bridge protocol v1

This document is the normative wire contract shared by the DevHub host and bundled OpenVSCode Bridge extension. R1.3 owns it. EditorHost and Bridge tasks may not alter it independently.

## Transport and authentication

The Bridge connects only to the loopback endpoint injected into its process environment and authenticates its WebSocket upgrade with an `Authorization: Bearer` header containing the injected ephemeral per-process token. Tokens never appear in message payloads, URLs, logs, runtime state, or reconnect snapshots.

Every message is strict JSON with exactly these envelope fields:

```text
version: 1
connection_id: UUID | null
sequence: safe unsigned integer
message_id: UUID
kind: MessageKind
payload: object
```

`connection_id` is `null` only on the initial `hello`; every later message uses the UUID assigned by `hello_accepted`. UUIDs are lowercase canonical hyphenated strings. Each sender creates globally unique `message_id` values. Sequence numbers and `connection_generation` values are unsigned integers in the exact safe range `1..=9007199254740991` (`2^53 - 1`), so Rust and JavaScript represent them identically. Unknown fields or kinds, wrong versions, non-canonical IDs, invalid sequences, oversized messages, and invalid payloads are protocol errors. The maximum encoded message size is 256 KiB.

## Shared payload types

`Context` is exactly one of:

```text
{ kind: "global" }
{ kind: "workspace", workspace_id: UUID, canonical_root: absolute UTF-8 path }
```

`Readiness` is `starting`, `ready`, or `unavailable`. Paths must be absolute, NUL-free, and lexically normalized. The host canonicalizes a requested path before applying domain identity rules.

## Handshake and identity binding

EditorHost generates a stable `surface_id` UUID for each Editor Surface and injects it with the endpoint and token. The Bridge generates a new `workbench_instance_id` UUID on extension activation; extension-host restart therefore creates a new value while `surface_id` remains stable.

The first client message is envelope sequence `1`, `connection_id: null`, kind `hello`:

```text
{ extension_version: SemVer, surface_id: UUID, workbench_instance_id: UUID }
```

The host accepts only the injected expected `surface_id` and responds at server sequence `1` with kind `hello_accepted`. Its envelope contains the newly assigned `connection_id`; the payload does not duplicate it:

```text
{ accepted_version: 1, surface_id: UUID, connection_generation: safe unsigned integer >= 1 }
```

The client then sends sequence `2`, kind `state_snapshot`, using the assigned connection ID:

```text
{ surface_id: UUID, readiness: Readiness, context: Context, dirty: boolean }
```

No other client message is valid before the snapshot. The snapshot contains no editor content, paths below the Workspace root, terminal data, prompts, clipboard data, or credentials.

On reconnect or extension-host restart, the Bridge repeats the handshake and full snapshot. The host increments `connection_generation` for the Surface and rejects events from an older connection. Applying a snapshot is idempotent and completely replaces the prior Bridge projection for that Surface.

## Message catalogue

Extension-to-host events are not acknowledged:

```text
ready_changed    { readiness: Readiness }
identity_changed { context: Context }
dirty_changed    { dirty: boolean }
state_snapshot   { surface_id: UUID, readiness: Readiness, context: Context, dirty: boolean }
```

Extension-to-host requests are:

```text
open_workspace_requested {
  absolute_path: absolute UTF-8 path,
  source: "open_folder" | "open_workspace" | "external_uri"
}

new_window_requested {
  absolute_path: absolute UTF-8 path | null,
  source: "command" | "external_uri" | "unknown"
}
```

`open_workspace_requested` opens or focuses the canonicalized Workspace. A `new_window_requested` with a path does the same; with `null` it focuses the singleton Global Editor because the MVP has one Workbench Window.

Host-to-extension requests are:

```text
request_state_snapshot { reason: "host_reconcile" | "manual_test" }
focus                  { reason: "navigation" | "window_restore" }
```

Each request receives exactly one `response` or `error`. `response` is:

```text
{
  request_message_id: UUID,
  result:
    { kind: "workspace_routed", context: workspace Context }
  | { kind: "global_routed", context: { kind: "global" } }
  | { kind: "snapshot_will_follow" }
  | { kind: "focused" }
}
```

`error` is:

```text
{
  request_message_id: UUID | null,
  code:
    "unsupported_version"
  | "invalid_identity"
  | "invalid_message"
  | "sequence_error"
  | "payload_too_large"
  | "surface_unavailable"
  | "request_failed"
  | "request_cancelled"
  | "bridge_timeout"
  | "connection_lost",
  summary: content-free UTF-8 string of at most 256 scalar values
}
```

`request_message_id` is `null` only when no valid request ID could be decoded. Result variants must match the request: routing requests return a routed Context, `request_state_snapshot` returns `snapshot_will_follow` before the snapshot event, and `focus` returns `focused`.

## Ordering, deduplication, and failure

After handshake, each sender increments its own sequence by exactly one. An exact duplicate frame with the same sequence and `message_id` is ignored after returning any cached request result; reusing a sequence with a different ID is a protocol error. A decreasing sequence or gap closes the connection with `sequence_error`; reconnect and the mandatory snapshot perform reconciliation rather than guessing at missing events.

The host keeps a bounded request-result ledger per stable `surface_id` across connection generations for the DevHub process lifetime: at least the latest 1,024 IDs and no less than ten minutes. Reusing an extension request `message_id` returns its recorded result without repeating the side effect. The extension needs only a per-activation ledger because both host requests are idempotent.

A request deadline is five seconds. Connection loss or timeout fails the pending request and triggers snapshot reconciliation. Neither side automatically retries a request across a connection generation. A later user intent creates a new `message_id`; replaying the old ID receives the ledger result and cannot duplicate Workspace routing.

Endpoint loss leaves the extension inactive without changing Workbench behavior. Host loss, version mismatch, invalid identity, or repeated protocol failure is visible in DevHub diagnostics and never causes the Bridge to control editor content or upstream features. Required folder and new-window interception remains a release gate as defined by ADR 0014.

## Generated contract and freeze gate

R1.3 implements these strict Rust source types and generates TypeScript bindings, JSON Schema, and valid/invalid fixtures. CI rejects hand-edited generated files and checks round-trip decoding, every payload variant, strict unknown-field rejection, path/ID validation, size limits, ordering, duplicate requests across reconnect, snapshot replacement, and content-free error serialization.

R1.3 is complete only when this document, generated schemas, fixtures, and contract tests agree. E3.4 and E3.5 do not begin before that freeze gate passes.
