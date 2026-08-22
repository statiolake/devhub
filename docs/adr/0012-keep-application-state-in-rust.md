# Keep Application State in Rust

DevHub uses Tauri 2 with a Rust backend and a React/TypeScript/Vite frontend. Rust owns the authoritative Application State and domain transitions. React renders immutable snapshots, sends user intents, and owns only ephemeral presentation state such as focus, hover, and in-progress input.

## Consequences

- Workspace lifecycle, navigation fallback, Activity availability, restoration, and provider reconciliation are implemented once in Rust.
- `AppCoordinator` orchestrates cross-module operations through deep modules: `ConfigStore`, `StateStore`, `WorkspaceDiscovery`, `WorkspaceManager`, `NavigationModel`, `EditorHost`, `AgentRuntime`, `TerminalRuntime`, and `KeyRouter`.
- Herdr, tmux, OpenVSCode, and Tauri/WRY types remain inside their adapters. Frontend snapshots expose only DevHub domain identities.
- `EditorHost` retains a future seam for Local, SSH, and Dev Container implementations. Agent and terminal runtimes are independently replaceable.
- The frontend is composed from App Shell, titlebar Activities, Sidebar, Workspace Picker, three Surface families, Settings, errors, and confirmation sheets without a generic dashboard component kit.
- The repository pins Rust, Node, pnpm, Tauri, WRY, OpenVSCode, and JavaScript dependency versions.
- Unit tests cover pure domain modules; real isolated sessions cover runtime adapters; native Apple Silicon release gates cover WKWebView, shortcuts, IME, persistence, and hot exit.
