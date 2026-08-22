# Confirm only resource destruction

DevHub confirms operations that terminate or discard owned runtime resources. Navigation, detachment, main Window Close, and app Quit do not prompt.

Closing a live Agent always presents one destructive confirmation. After confirmation the row enters a non-interactive stopping state until the provider pane disappears. Failure keeps the Agent visible with retry and diagnostic actions.

Closing a clean Workspace is immediate. A busy Workspace presents one consolidated sheet listing running Agents, terminal processes and panes, and unsaved editors. Confirmation terminates all owned resources; the MVP does not offer per-resource exceptions.

## Consequences

- Agent close is available from a row affordance and `Stop Agent…` context action.
- Workspace close is available as `Close Workspace…` and uses the previously defined busy inspection.
- Cleanup must be confirmed before navigation state is deleted.
- Partial cleanup remains visible and retryable instead of pretending the operation succeeded.
- Main Window Close, app Quit, Activity and context navigation, terminal detach, and picker cancellation never display destructive confirmation.
