# Vendored built-in extensions

Third-party extensions DevHub ships as built-ins, unpacked from a published
VSIX and committed as they came.

They are here rather than beside `devhub-bridge` because `pnpm-workspace.yaml`
globs `extensions/*`: a published extension's `package.json` carries the
author's own `devDependencies` and `postinstall`, and a directory one level
down is not a workspace package. Nothing here is built, and nothing here is
installed — the manifest is kept byte-for-byte as published so the checksum
below stays the whole story.

`scripts/stage-builtin-extensions.sh` links every directory here into the
built-in set, alongside `devhub-bridge` and VS Code's own.

## Why vendor rather than download

A built-in extension is not optional: a person cannot install it, and cannot be
without it. Downloading one at launch would make DevHub's own feature set
depend on a registry being reachable, and a first launch on a train would come
up without SSH. The tree is the pin.

## What is here

### open-remote-ssh

| | |
| --- | --- |
| Extension | `jeanp413.open-remote-ssh` |
| Version | `0.3.1` |
| Source | `https://open-vsx.org/api/jeanp413/open-remote-ssh/0.3.1/file/jeanp413.open-remote-ssh-0.3.1.vsix` |
| VSIX sha256 | `c6f16b225ab86925f2bd9e8cc5ba31e614978ccfa120f1509bdf6e99e5bef13f` |
| Licence | MIT (`open-remote-ssh/LICENSE.txt`) |

The `vscode-remote://ssh-remote+<host>/<path>` resolver. It is what makes an
SSH Workspace a Workspace: DevHub opens the workbench on that URI and this
extension answers `onResolveRemoteAuthority:ssh-remote` by connecting over SSH,
installing the remote extension host, and handing back a port.

Its two proposed APIs — `resolvers` and `contribViewsRemote`, as declared by
its own `enabledApiProposals` — are granted in
`scripts/product_metadata.py`. Without the grant the extension host logs
`CANNOT use API proposal: resolvers.` and the authority never resolves.

To update: fetch the new VSIX, check its sha256, unpack `extension/` over this
directory, reconcile `enabledApiProposals` with the grant table, and update the
version and checksum above.
