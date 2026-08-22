# Set MVP quality budgets

DevHub `0.1.0` is an English-only product UI with full UTF-8 path and Japanese IME support. It provides keyboard focus, VoiceOver labels, visible focus rings, non-color-only status presentation, reduced-motion behavior, and usable text zoom.

## Consequences

- Target cold shell presentation is two seconds, Scratch interaction three seconds, first Workspace Picker results 300 ms, mounted Activity switching 100 ms, cold OpenVSCode interaction ten seconds, and warm Workbench reconstruction five seconds on the target Apple Silicon machine.
- Scanning, configuration, and runtime-state persistence never block the UI thread and remain cancellable where applicable.
- Release validation covers eight open Workspaces, sixteen live Agents, all nine resulting Editor WebViews including Global Editor, normal tmux pane and window use, ten-minute hidden Surfaces, repeated Window and app lifecycles, and independent provider crashes.
- Recovery tests include external and invalid TOML edits, symbolic-link configuration, corrupt state, unusual paths, normal clones, and linked worktrees.
- Japanese product localization is deferred beyond the MVP.
