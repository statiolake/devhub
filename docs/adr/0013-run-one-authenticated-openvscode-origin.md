# Run one authenticated OpenVSCode origin

DevHub runs one bundled, pinned OpenVSCode Server process on `127.0.0.1` and gives every Editor Surface the same stable origin. The first successful launch selects and persists a port; later launches fail visibly rather than silently changing origin when that port is occupied.

Authentication uses a generated 32-byte token stored in an owner-readable token file under `Application Support/DevHub/OpenVSCode`. OpenVSCode receives only the token-file path. Server data, extensions, and logs remain in the same application-owned directory. Telemetry and experiments are disabled while Workspace Trust remains upstream behavior.

## Consequences

- Global and Workspace Editor Surfaces share one persistent WebKit website data store that is isolated from the Tauri App Shell store.
- Editor child WebViews receive no Tauri IPC capability or injected global API.
- Activity changes hide and show existing WebViews without reload and with background throttling disabled.
- Window Close destroys Editor WebViews but leaves the server running; app Quit stops the server. Server crash uses bounded restart backoff.
- OpenVSCode uses Open VSX and manually installed VSIX packages rather than the Microsoft Marketplace.
- External links opened by an explicit user action go to the default browser. Folder and new-Workbench requests are translated into DevHub Workspace operations.
- Changing the persisted port requires an explicit recovery action and warns that WebKit origin storage changes even though server-side settings and extensions remain.
