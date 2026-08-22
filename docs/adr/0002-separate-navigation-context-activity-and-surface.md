# Separate navigation context, Activity, and Surface

DevHub separates the left-pane Navigation Context, the fixed top-level Activity choices, and the concrete Surface being displayed. Selecting a Workspace opens its Editor Activity; selecting an Agent opens its Agent Activity; while that Agent remains selected, Editor and Terminal resolve to the resources shared by its Workspace. This avoids closeable browser-style tabs, preserves cross-Workspace Agent visibility, and prevents duplicate Editor or Terminal resources per Agent.

## Consequences

- MVP Activities are Editor, Agent, and Terminal; inapplicable Activities are disabled rather than removed.
- The Global Context defaults to Scratch Terminal and also owns one folderless Editor Surface.
- A Workspace with no Agents has no empty child row or disclosure affordance.
- When a selected Agent exits, the next sibling Agent is selected; if none remains, its Workspace Editor is selected.
