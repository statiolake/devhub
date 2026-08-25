# DevHub MVP Product Specification

## Product outcome

DevHub `0.1.0` is a daily-usable, personal, macOS-first development hub that presents one stable place to switch among local Workspaces, autonomous Agents, persistent terminals, and an embedded VS Code Workbench. It is a greenfield product, not a wrapper around the VS Code desktop app and not a visual shell for Herdr.

The MVP is complete only when an Apple Silicon app can be downloaded from a public GitHub Release, installed locally, opened repeatedly without terminating background work, and used for the full Workspace, Editor, Agent, and Terminal lifecycle defined below.

## Platform and distribution

- Product name: DevHub
- Version: `0.1.0`
- Bundle identifier: `io.github.statiolake.devhub`
- Platform: Apple Silicon, macOS 15 or later
- Repository: public `statiolake/devhub`, MIT License
- Artifact: `DevHub-v0.1.0-macos-arm64.zip` plus SHA-256 and notices
- Signing: ad-hoc only; no certificate signing or notarization
- Out of scope: Intel, Windows, Linux, DMG, automatic update

## Domain invariants

The canonical vocabulary and ownership rules are defined in [CONTEXT.md](../CONTEXT.md). The decisions behind this specification, with their rationale and consequences, are recorded in [adr/](adr/). Canonical path, label, Repository, tmux ownership, and busy-inspection algorithms are normative in [IDENTITY-AND-LIFECYCLE.md](IDENTITY-AND-LIFECYCLE.md). The complete TOML schema is normative in [CONFIGURATION.md](CONFIGURATION.md).

- A Workspace is a currently open folder-root context with a persisted opaque Workspace ID. Its canonical Workspace Root is the duplicate-prevention key: the same root cannot be open twice, but relocating an `Unavailable` Workspace preserves its ID while changing its root.
- A Repository is a Git remote identity and may have multiple Workspace Roots, including linked worktrees.
- Filesystem and Git are the source of discovery truth; there is no registered-root database.
- An Agent belongs to exactly one Workspace but is not a Herdr pane or terminal.
- Global Context is a non-closeable singleton that owns Global Editor and Scratch Terminal.
- Each Workspace owns its Editor and Terminal resources; Global Context separately owns Global Editor and Scratch. Selecting an Agent does not create per-Agent copies.
- Herdr owns Agent execution only. tmux owns Workspace and Scratch terminals only.
- Closing a Window or quitting DevHub does not terminate Agents or tmux sessions.

## Navigation and main UI

The MVP has one main Workbench Window and one optional singleton Settings Window.

The main Window contains:

- native macOS titlebar and traffic lights;
- titlebar Activities: Editor, Agent, Terminal;
- resizable Sidebar;
- one Surface viewport;
- no subtitle strip, browser-style tabs, decorative cards, or bottom status bar.

Sidebar order is stable:

1. Scratch, fixed at the top;
2. Workspaces in open order;
3. Agent children in creation order.

A Workspace without Agents has no disclosure, placeholder, or child tree. Runtime status never changes ordering. Workspace and disclosure clicks are separate targets. Workspace order, disclosure state, Sidebar width, and navigation are restored. The Sidebar defaults to 248 points and resizes between 200 and 400. Below the minimum main-Window width the Surface may shrink, but Sidebar controls never overlap or disappear. Workspace labels use the root basename and the shortest unique parent suffix when basenames collide; they are not user-renamable in the MVP.

### Navigation matrix

| Selection | Immediate Activity | Editor | Agent | Terminal |
| --- | --- | --- | --- | --- |
| Scratch / Global | Terminal | Global folderless Editor | Disabled | Scratch Terminal |
| Workspace | Editor | Workspace Editor | Disabled | Workspace Terminal |
| Agent | Agent | Owning Workspace Editor | Selected Agent | Owning Workspace Terminal |

Changing Activity never changes Navigation Context. Selecting a Workspace always opens Editor. Selecting an Agent always opens Agent. When a selected Agent exits, DevHub selects the next sibling Agent or falls back to the owning Workspace Editor.

## Workspace Discovery and lifecycle

The Workspaces heading `+` opens a streaming fuzzy Workspace Picker. Sources are configured in TOML and may be filesystem scans or shell-free command arrays. Candidates support directories, normal Git repositories, and linked worktrees. Nested repositories are retained and canonical paths are deduplicated.

The default personal configuration supports:

- dynamic `workspace_path -d` output;
- Git repositories/worktrees below `~/dev` to depth 4;
- first-level directories below `~/workspace/work`;
- shallow Git repositories/worktrees below the home directory.

Candidate Git remotes are resolved asynchronously into Repository identities. Selecting an already-open canonical root focuses it. `Open Folder…` is always available.

New Workspace creation, Clone Repository, Issue URL resolution, worktree creation, and Dev Container launch are not MVP picker actions.

Explicit Workspace Close inspects running Agents, terminal processes, terminal pane/window count, and unsaved editors. Every inspector returns clean, busy, or unknown; unknown is never treated as clean and appears as an unverifiable resource. Clean Workspaces close immediately. Busy or unknown Workspaces show one consolidated destructive confirmation. Cleanup removes Agents, the Workspace tmux session, its Editor Surface, and finally runtime state. Partial failure remains visible and retryable.

Missing roots remain as `Unavailable` with Retry, Locate, and Close actions.

## Editor Activity

DevHub runs the user's separately installed official VS Code through
`code serve-web`. It never bundles, downloads, patches, or redistributes a
Workbench. One loopback server process serves all Editor Surfaces.

- CLI discovery: `DEVHUB_VSCODE_CLI`, then `PATH`, then the canonical Homebrew and application-bundle locations
- Capability probe: version, commit, architecture, and the required `serve-web` flags are validated before every launch; a missing flag fails closed
- Bind: `127.0.0.1` only
- Port: selected once, persisted, and stable
- Authentication: generated 32-byte token in an owner-readable token file
- Data: application-owned server-data, CLI-data, and extension directories, isolated from the user's own VS Code profile
- Marketplace: whatever the installed VS Code provides
- Telemetry: disabled
- Workspace Trust and Integrated Terminal: upstream behavior retained

The VS Code Server carries Microsoft's own license terms. DevHub does not pass
`--accept-server-license-terms`: with no controlling terminal the CLI prints
its license notice, starts without prompting, and forwards the flag to the
server itself. The Editor Surface shows the same notice and links the terms, so
DevHub never records an acceptance on the user's behalf.

All Editor child WebViews share one persistent Workbench WebKit data store that is isolated from the Tauri App Shell. Child WebViews receive no Tauri IPC capability. Activity changes hide and show mounted WebViews with background throttling disabled.

Global Editor is a folderless singleton. An Open Folder or new-Workbench request opens or focuses a DevHub Workspace and never converts Global Editor.

A narrow bundled Bridge extension reports Workbench identity/readiness, dirty state, folder/new-window requests, and extension-host reconnection over a loopback endpoint with an ephemeral token. It is installed through the public `code --install-extension` command, uses public VS Code APIs, and never reads content, controls Integrated Terminal/Tasks/Debugger, or owns navigation.

The Workbench is never forked. A narrowly pinned Tauri/WRY host fork is allowed only for embedding or native macOS key routing.

## Agent Activity

Herdr is hidden behind `AgentRuntime`. The adapter owns `devhub-session` bootstrap, protocol compatibility, snapshot reconciliation, launch, terminal control, controller ownership, and termination. Provider workspace, tab, pane, agent, and terminal identifiers never reach product UI.

MVP Agent Profiles are TOML-defined Codex or Claude profiles with ID, display name, arguments, and environment. Arbitrary executable profiles are outside the MVP.

Creating an Agent:

1. select `+` on a Workspace row;
2. select an enabled Profile;
3. create the Herdr resource at the Workspace Root;
4. add a stable Sidebar row;
5. open Agent Activity and attach xterm terminal control;
6. enter the task interactively in the Agent Surface's provider control stream.

Default instance names are profile display names with a local ordinal and may be renamed while alive. Rows present accessible `working`, `waiting`, `idle`, or `error` status. Collapsed Workspaces aggregate `error > waiting > working > idle`.

Natural process exit removes the Agent in the same reconciled update that confirms exit, then closes the residual pane idempotently. Explicit Stop always confirms, shows a stopping state, waits for closure, and remains retryable on failure. Detaching a Surface or quitting DevHub never terminates the Agent.

## Terminal Activity

DevHub uses a dedicated tmux socket server selected by the effective socket name, default `devhub`, while loading the user's normal tmux configuration. Settings may show a different configured name as pending until its confirmed terminal reset completes.

- Global Context owns non-closeable Scratch, rooted at the home directory.
- Each Workspace owns one independent session rooted at its canonical Workspace Root.
- Session identity is deterministic and verified against root metadata.
- Normal tmux panes, windows, keybindings, themes, and external attachment remain available.
- Missing sessions are recreated when needed; Scratch is always recreated.
- Window Close and app Quit detach only.
- Explicit Workspace Close terminates its session after the consolidated busy check.
- tmux panes and windows remain internal to the single owning Terminal Surface and never become DevHub navigation entries.

VS Code Integrated Terminal remains available independently inside the Workbench.

## Keyboard routing

In the main Window, `Command+Q` is a one-second DevHub prefix. The first press is withheld. A second `Command+Q` within one second sends one native `Command+Q` to the active Surface. Timeout or any unmapped second key silently clears the prefix. There is no indicator, toast, or beep.

- Quit has no keyboard equivalent and remains in the App/Dock menu.
- `Command+W` is delivered to the active Workbench Surface; the main Window closes through the traffic light or a shortcut-free menu action.
- `Command+,` opens the singleton DevHub Settings Window.
- `Command+M` and `Command+H` retain macOS behavior.
- Settings uses `Command+W` to close itself.

Synthetic JavaScript key events are not acceptable for the native forwarding path.

## Settings and runtime dependencies

User configuration lives at `~/.config/devhub/config.toml`. Runtime state lives at `~/Library/Application Support/DevHub/state.json`. [CONFIGURATION.md](CONFIGURATION.md) defines every field, default, validation rule, and hot-reload boundary.

- Settings UI and direct TOML editing are equal interfaces.
- Symlinks are preserved and their targets are updated atomically.
- TOML comments/order are preserved where possible.
- External edits hot-reload transactionally.
- Invalid TOML keeps the last-known-good configuration and reports file/line/column.
- Conflicting Settings writes never silently overwrite external changes.
- Workspace sources, the available Agent Profile list, and Appearance settings apply live. Existing Agents retain their launch-time Profile snapshot.
- executable paths apply on next DevHub launch.
- runtime state is schema-versioned, atomic, backed up, and never synced through dotfiles.

DevHub resolves the official VS Code CLI, and the configured shell, Git, tmux, and Herdr from absolute paths or the imported login-shell PATH. Herdr resolves Codex and Claude in the same environment. Missing dependencies degrade only related features and remain diagnosable in Settings > Runtimes.

Settings sections are General, Workspaces, Agents, Runtimes, and Appearance. No first-run wizard is required.

Runtimes shows configured, resolved, and effective runtime values. If a tmux socket-name change is pending behind live DevHub terminal sessions, `Apply socket change…` confirms the exact sessions that will be destroyed, switches only after verified cleanup, and recreates fresh Scratch and open-Workspace terminals. It never affects Agents or Editors.

## App lifecycle and recovery

Window Close destroys the Window and Editor WebViews but leaves the DevHub process, Workbench server, Herdr, Agents, and tmux running. Dock activation reconstructs the single Window.

Quit stops DevHub and its Workbench server but leaves Herdr, Agents, and tmux running. Relaunch restores open Workspaces with their persisted Workspace IDs and selected/canonical paths, order, disclosure, selected context, Activity, Agent identity, temporary Agent names, Sidebar size, and Window frame. Provider-owned terminal/editor state is restored by the provider.

Workbench, Herdr, and tmux failures are isolated. Unrelated Activities remain usable. Runtime failure never silently deletes durable state. Corrupt state restores its backup or starts safely with Global Context and Scratch.

## Security, diagnostics, and privacy

DevHub is a single-user local application. It binds local services to loopback, authenticates Workbench and Bridge connections, scopes Tauri capabilities to the App Shell, and exposes no cloud account or remote listener in the MVP.

Structured logs rotate under `~/Library/Logs/DevHub`. Logs include versions, lifecycle, error codes, provider exits, retries, and migrations. They never include terminal frames/input, editor content, Agent prompts/conversations, clipboard, credentials, tokens, environment values, URL queries, or full external command output. No telemetry or automatic upload exists.

## Visual and accessibility direction

The UI is an English-only, quiet macOS professional tool using the approved Zenbones-derived palette. It follows the system appearance: every palette role resolves for light and dark, and no surface is painted outside that palette. VS Code and xterm themes remain provider settings. The App Icon depicts three panes converging into one hub and is generated from one vector master.

All actions have keyboard focus, VoiceOver labels, visible focus rings, non-color-only state, reduced-motion behavior, and usable text zoom. UTF-8 paths and Japanese IME are mandatory.

## Release gates

The MVP cannot release until all of the following pass on Apple Silicon:

- official VS Code CLI discovery, capability probe, and authenticated loopback launch;
- two real Workbench WebViews with independent folder identity;
- ordinary native Command shortcuts and Japanese IME;
- native double-`Command+Q` forwarding;
- hide/show, ten-minute hidden continuity, resize, focus restoration, and hot exit;
- Bridge readiness, dirty state, folder/new-window handling, and extension-host restart;
- Herdr Codex/Claude launch, exit cleanup, reconnect, conditional takeover, and protocol mismatch;
- tmux Scratch/Workspace persistence, external attach, recreation, and close inspection;
- config symlink/hot reload/error behavior and corrupt-state recovery;
- scale matrix: eight Workspaces, sixteen Agents, and all nine resulting Editor WebViews including Global Editor;
- repeated Window Close/reopen and Quit/relaunch while work continues;
- downloadable ad-hoc-signed app from the public `v0.1.0` GitHub Release.

Failure of a feasibility gate blocks the release with evidence. It does not authorize a Workbench fork, a silent product-model change, or removal of an accepted MVP requirement.

## Explicitly deferred

### Second development

- Issue and Pull Request Activities
- GitHub URL to Repository/Workspace resolution
- clone and worktree provisioning
- structured task composer
- diff and changed-files Surfaces
- arbitrary Agent runtimes

### Third development

- SSH and Dev Container EditorHosts
- multiple main Workbench Windows
- Windows and Linux
- certificate signing, notarization, and automatic updates
