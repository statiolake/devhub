# Use a narrow OpenVSCode Bridge

DevHub bundles a narrow OpenVSCode extension that reports Workbench identity, readiness, dirty state, folder or new-Workbench requests, and extension-host reconnection. It communicates with a loopback-only DevHub endpoint using a per-process token and a versioned message schema.

The Bridge uses only public VS Code extension APIs. It does not read or modify editor content, process keystrokes, govern Integrated Terminal, Tasks, or Debugger, own navigation, or expose OpenVSCode implementation types.

## Consequences

- The Bridge receives its endpoint and ephemeral token through the OpenVSCode process environment. The token is not durable.
- A missing DevHub endpoint leaves the extension quietly inactive.
- DevHub validates Bridge protocol version and Workbench identity before accepting state.
- Folder and new-Workbench requests are observed through public extension APIs where possible and through host URL or new-window interception as a second boundary.
- Such requests open or focus a DevHub Workspace and never convert the folderless Global Editor.
- If required upstream behavior cannot be intercepted through either supported boundary, the feasibility gate fails and blocks release. DevHub does not fork the Workbench, ship a silent invariant violation, or treat an unsupported diagnostic as MVP completion.
- Real Workbench tests for folder open, new-window requests, dirty state, and extension-host restart are release gates.
