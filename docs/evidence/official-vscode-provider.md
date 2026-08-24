# Official VS Code Web provider proof

This is local macOS arm64 technical evidence. It proves the BYO provider
boundary; it is not a Microsoft license acceptance record and is not hosted
release evidence.

## Environment

```text
CLI: /usr/local/bin/code
VS Code: 1.134.0
commit: 110a328ea54b42367b803ec53ee0bf52ef26b419
architecture: arm64
```

The CLI was invoked from an isolated `HOME`, `VSCODE_CLI_DATA_DIR`,
server-data directory, token file, and workspace. No VS Code or Server binary
was copied into the DevHub repository.

## Readiness and Bridge

The following public commands were used:

```sh
code --version
code serve-web --help
code --install-extension /absolute/path/devhub-bridge-0.1.0.vsix \
  --extensions-dir /isolated/server-data/extensions \
  --force
code serve-web --host 127.0.0.1 --port <free-port> \
  --connection-token-file /isolated/token \
  --server-data-dir /isolated/server-data \
  --default-folder /isolated/workspace --disable-telemetry
```

The CLI accepted the Bridge VSIX with the manifest engine `^1.109.0` on VS
Code 1.134.0. The first authenticated HTTP request returned the expected
Workbench redirect/HTML response, and a browser WebSocket reached the
Workbench. A headless Web Workbench loaded the workspace in Restricted Mode;
the Bridge extension activated and the owner endpoint observed:

```text
hello (surface_id=..., workbench_instance_id=...)
hello_accepted (connection_generation=1)
state_snapshot (readiness=ready, context=workspace, dirty=false)
```

After a provider/browser restart the extension reconnected with a fresh
`workbench_instance_id` and `connection_generation=2`, proving the generation
and reconnect boundary. The workspace identity used the official
`vscode-remote` URI scheme and matched the Rust-owned canonical-root registry.

Two simultaneous loopback servers using separate server-data directories both
reached authenticated HTTP readiness. Their extension ledgers were distinct,
demonstrating that DevHub can isolate provider profiles without reusing the
user's normal VS Code profile. DevHub does not claim that Microsoft's Settings
Sync account is available or required; DevHub's own local settings/state
remain the source of truth.

## Consent boundary

The official Server terms were displayed by the CLI during proof. DevHub's
production adapter does not add `--accept-server-license-terms` implicitly. A
normal launch without explicit local consent returns `license_consent_required`;
the setup command/environment documented in
[`docs/PROVIDER-CONTRACTS.md`](../PROVIDER-CONTRACTS.md) is required only after
the user has accepted the official terms.
