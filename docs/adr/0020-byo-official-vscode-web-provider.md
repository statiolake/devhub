# Use a BYO official VS Code Web provider

## Decision

DevHub's Editor Activity runs the user's separately installed official VS Code
through `code serve-web`. It is the only provider. DevHub never bundles,
downloads, patches, or redistributes the VS Code application or Server.

The provider owns executable discovery, version/commit/architecture probing,
capability validation, loopback launch arguments, app-owned
server-data/CLI-data/extension paths, and public `code --install-extension`
Bridge installation. The common EditorHost owns tokens, readiness, the surface
registry, WebViews, Bridge transport, navigation, and recovery. No
provider-specific branch is allowed in App Shell state or the Bridge wire
contract.

Official VS Code may self-update, so every launch probes the current CLI and
fails closed when a required `serve-web` flag is absent.

## License

The VS Code Server is covered by Microsoft's own license terms, which permit a
licensed user to run it to develop and test their own applications and forbid
hosting, publishing, or combining it with an application for others to use.
BYO keeps DevHub on the permitted side: each user runs their own licensed copy
on their own machine, and DevHub ships none of it.

DevHub does not pass `--accept-server-license-terms`. With no controlling
terminal the CLI prints its license notice, starts without prompting, and
forwards the flag to the server itself, so a DevHub-side consent gate would
block startup without obtaining any consent. The Editor Surface shows the same
notice and links the terms instead.

## Why not a self-built Code-OSS

Code-OSS is MIT and declares no server license, which would remove the license
question and let DevHub ship a self-contained app. It was rejected for the MVP:

- the artifact is roughly 500 MB against a 17 MB app;
- it has no extension gallery, so Open VSX or manual VSIX provisioning becomes
  a product decision;
- `defaultChatAgent` lives in the MIT `product.json` and the Chat UI is
  compiled into the workbench core, so Copilot entry points appear but cannot
  resolve their proprietary extension;
- the upstream packaging graph expects a Copilot SDK that is not part of the
  open source tree, so the build needs a maintained workaround;
- distributing bundled native binaries turns signing and notarization from
  optional into required.

It stays the credible answer if BYO ever becomes untenable. Because the
provider seam is preserved, adding it is a new executable adapter rather than a
re-plumbing of EditorHost.

## Consequences

- A user must install and license official VS Code independently. A missing
  `code` command is a typed, actionable Editor error rather than a silent
  empty Surface.
- The Bridge remains a public VS Code extension API consumer and supports
  Restricted Mode through `untrustedWorkspaces.supported: true`.
- The official Workbench's `vscode-remote` URI scheme is accepted only after
  Rust-owned canonical-root validation.
- The server-data directory is DevHub-owned and isolated from the user's
  consumer VS Code profile, so Settings Sync is not an implicit product
  dependency.
