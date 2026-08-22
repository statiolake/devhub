# Keep Sidebar order stable

DevHub keeps Scratch, Workspaces, and Agents in a stable spatial order. Scratch is fixed first. Workspaces retain open order, and Agents retain creation order. Runtime status never reorders either collection.

## Consequences

- The Workspaces heading owns the Workspace Picker action.
- Clicking a Workspace row selects its Editor Activity. A separate disclosure control expands or collapses Agent children.
- A disclosure control exists only when the Workspace has Agents; there is no empty child or placeholder.
- Agent creation is available from the owning Workspace row and moves navigation to the created Agent Surface.
- Default Agent names use the profile display name with a local ordinal and may be renamed for the lifetime of the Agent.
- Agent rows show `working`, `waiting`, `idle`, or `error`. A collapsed Workspace shows the highest-priority descendant state using `error > waiting > working > idle`.
- Workspace order, disclosure state, and Agent instance names are restored. Drag reordering is outside the MVP.
- Agent status is presented only in the Sidebar; DevHub does not add an app status bar.
