# Embed an upstream Workbench without governing its features

DevHub embeds an upstream VS Code Web workbench and owns its placement, selection, lifecycle, and persistence. It does not fork the workbench or disable features inside it. A host-only Tauri or WRY patch is allowed when native embedding or macOS Command-key routing cannot be implemented through supported host APIs.

One local Workbench server process serves the folderless Global Editor and the Editor Surface of each open Workspace. Each Surface is a distinct child WebView with stable origin and stable WebKit storage. Hidden Editor Surfaces remain mounted and background throttling is disabled.

## Consequences

- VS Code Integrated Terminal, Tasks, Debugger, extensions, and other workbench features remain available.
- DevHub Terminal Activity is a separate persistent tmux shell and does not replace or police the VS Code Integrated Terminal.
- Global Editor remains a folderless singleton. Opening a folder from it opens or focuses a DevHub Workspace instead of converting the Global Editor.
- The Workbench is supplied by the user's own installation and updated by its vendor rather than maintained as a product fork. See [0020](0020-byo-official-vscode-web-provider.md).
- Host integration first uses URL interception and a narrow bridge extension. A workbench fork is outside the MVP boundary.
- Command-key routing is a release gate for the host layer. A JavaScript-only simulation is not proof that native key equivalents reach the real workbench.
