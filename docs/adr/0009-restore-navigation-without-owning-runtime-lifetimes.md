# Restore navigation without owning runtime lifetimes

DevHub persists enough application state to reconstruct the single main Window and its Navigation Context without treating the Window or app process as the owner of Agent and terminal runtimes.

Closing the macOS Window closes its Workbench views while leaving the DevHub process, OpenVSCode Server, Herdr, Agents, and tmux sessions running. Quitting DevHub also stops its OpenVSCode Server, but Herdr, Agents, and tmux sessions continue. Neither action requires an app-specific confirmation.

## Consequences

- Runtime state stores each open Workspace ID with selected and canonical paths, Workspace order, Sidebar expansion and width, active Navigation Context and Activity, Agent provider mappings and temporary names, the effective tmux socket name, native Window frame, schema version, and clean-shutdown metadata.
- Reopening the Window reconstructs child WebViews. OpenVSCode workspace storage and hot exit own editor restoration.
- A missing active Agent falls back to its next sibling and then the owning Workspace Editor.
- A missing Workspace Root remains visible as `Unavailable` with Retry, Locate, and Close actions.
- Editor, Agent, and terminal runtime failures are isolated; an unavailable runtime does not disable unrelated Activities or silently delete durable state.
- Corrupt runtime state restores from a backup or starts in the Global Context with Scratch only.
- Explicit Workspace close checks owned activity, terminates Agents and its tmux session, discards its Editor Surface, and removes state only after cleanup is confirmed. Partial failure remains retryable.
