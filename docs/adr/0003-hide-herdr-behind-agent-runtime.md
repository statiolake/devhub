# Hide Herdr behind AgentRuntime

DevHub treats Herdr as an implementation detail behind one `AgentRuntime` adapter. The adapter owns session bootstrap, protocol compatibility, snapshot reconciliation, Agent launch, terminal attachment, conditional controller takeover, and idempotent termination. Product code uses only DevHub `AgentId`, `WorkspaceId`, `WorkspaceRoot`, and `AgentProfile`; Herdr workspace, tab, pane, terminal, and agent names never cross the adapter boundary.

For the MVP, an Agent Profile selects a Herdr-supported runtime kind (`codex` or `claude`) plus arguments and environment. Arbitrary executable profiles are deferred until Herdr exposes a compatible public launch contract.

## Consequences

- `devhub-session` is started and health-checked by the adapter. A protocol mismatch is a hard failure before any mutation.
- DevHub persists its own Agent identity and an opaque provider mapping. Herdr terminal IDs are never durable identities.
- Runtime events invalidate a snapshot; they are not applied as an independent source of truth.
- Natural Agent exit removes the Agent in the same reconciled update that confirms the exit. The adapter then closes the residual pane idempotently and retries cleanup behind a tombstone if needed.
- Explicit Agent close closes the backing pane and removes the Agent after closure is confirmed.
- Detaching an Agent Surface or quitting DevHub releases terminal control but never terminates the Agent.
- A writable Agent Surface does not take over an existing controller unless DevHub can prove that it owns no other live Surface for that Agent.
