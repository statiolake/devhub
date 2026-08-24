# DevHub Bridge

This is the production Web Workbench extension boundary for DevHub. It runs in
the pinned OpenVSCode fallback and in a supported user-installed official VS
Code Server. It reports only Workbench identity, readiness, dirty state, and
supported navigation requests over the frozen Bridge v1 contract. It never
reads editor content, intercepts keys, or governs the upstream Integrated
Terminal, Tasks, or Debugger.

The extension is inactive when the injected loopback endpoint, bearer token,
or EditorHost-owned `DEVHUB_BRIDGE_SURFACE_REGISTRY` is absent or invalid. The
registry is a strict owner-only JSON file containing the matching surface and
workspace IDs for the Global context or the first public workspace folder; it
never contains the bearer token. Build and package it from the repository root
with `pnpm --filter @devhub/bridge check`.

The URI boundary uses the standard VS Code extension URI handler with the
product-provided `vscode.env.uriScheme` and `/open-workspace` or `/new-window`
paths; it does not claim a custom scheme. Only a single `path` query value is
accepted and it must be an absolute, lexically normalized path. The two public
commands in the manifest are the folder/new-window interception fallback.

The manifest declares `capabilities.untrustedWorkspaces.supported: true` so
the extension can activate in Restricted Mode. Official VS Code's
`vscode-remote` workspace URI is accepted only after the Rust-owned registry
confirms the canonical root. DevHub does not redistribute the official VS
Code application or auto-accept its Server license.

## Web Workbench smoke command

The pure controller, registry, and RFC6455 tests run with:

```sh
CI=true pnpm --filter @devhub/bridge check
```

On the pinned Darwin arm64 OpenVSCode artifact, or a user-installed official
VS Code CLI via `code serve-web`, run the real extension-host activation lane
with the inherited endpoint/token/registry environment:

```sh
DEVHUB_BRIDGE_ENDPOINT='ws://127.0.0.1:<host-port>/bridge' \
DEVHUB_BRIDGE_TOKEN='<ephemeral-token>' \
DEVHUB_BRIDGE_SURFACE_REGISTRY='/absolute/path/surface-registry.json' \
/absolute/path/openvscode-server \
  --host 127.0.0.1 --port <workbench-port> \
  --install-extension /absolute/path/build/devhub-bridge-0.1.0.vsix
```

The E3.4 host harness must assert activation/hello, dirty-state changes,
folder and global new-window requests, endpoint loss/reconnect, and a fresh
`workbench_instance_id` after extension-host restart. The extension package
itself never starts or supervises OpenVSCode.
