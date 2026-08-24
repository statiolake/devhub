# Use a BYO official VS Code Web provider

## Decision

DevHub's EditorHost exposes one provider-neutral lifecycle seam. On macOS,
`auto` prefers a separately installed official VS Code `code` CLI when its
version and `serve-web` capabilities satisfy the contract. The pinned,
app-owned OpenVSCode build remains an explicit legacy fallback. DevHub never
bundles, downloads, patches, or redistributes the official VS Code application
or Server.

The official adapter owns executable discovery, version/commit/architecture
probing, capability validation, loopback launch arguments, app-owned
server-data/extensions paths, and public `code --install-extension` Bridge
installation. The common EditorHost continues to own tokens, readiness,
surface registry, WebViews, Bridge transport, navigation, and recovery. No
provider-specific branches are allowed in App Shell state or the Bridge wire
contract.

## Consent and updates

Official VS Code may self-update. Every launch probes the current CLI and fails
closed when the required Web Workbench flags are absent. The Server license is
an explicit setup boundary: DevHub does not add
`--accept-server-license-terms` unless the user has already accepted the terms
and enabled the local consent setting. Without consent the host reports
`license_consent_required`.

The server-data directory is DevHub-owned and isolated from the user's normal
consumer VS Code profile. Settings Sync is therefore not an implicit product
dependency; DevHub persists its own settings/state through its existing local
configuration contract. Separate provider profiles use separate server-data
directories and preserve distinct identity/extension ledgers.

## Consequences

- A user must install and license official VS Code independently.
- The Bridge remains a public VS Code extension API consumer and supports
  Restricted Mode through `untrustedWorkspaces.supported: true`.
- The official Workbench's `vscode-remote` URI scheme is accepted only after
  Rust-owned canonical-root validation.
- Existing OpenVSCode Q5 endurance runs select `openvscode` explicitly, so
  provider auto-discovery cannot change their measurement boundary.
