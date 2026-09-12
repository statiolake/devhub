# Vendored built-in extensions

Third-party extensions DevHub ships as built-ins, unpacked from a published
VSIX and committed as they came — plus, where DevHub had to change one, the
edits that make it DevHub's. Those are in `patches/`, and
`scripts/patch_vendored_extensions.py` is the register of them.

They are here rather than beside `devhub-bridge` because `pnpm-workspace.yaml`
globs `extensions/*`: a published extension's `package.json` carries the
author's own `devDependencies` and `postinstall`, and a directory one level
down is not a workspace package. Nothing here is built, and nothing here is
installed — the manifest is kept byte-for-byte as published, so the checksum
below plus the edit table is the whole story.

`scripts/stage-builtin-extensions.sh` links every directory here into the
built-in set, alongside `devhub-bridge` and VS Code's own.

## Why vendor rather than download

A built-in extension is not optional: a person cannot install it, and cannot be
without it. Downloading one at launch would make DevHub's own feature set
depend on a registry being reachable, and a first launch on a train would come
up without SSH. The tree is the pin.

## What is here

### open-remote-ssh

|             |                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Extension   | `jeanp413.open-remote-ssh`                                                                         |
| Version     | `0.3.1`                                                                                            |
| Source      | `https://open-vsx.org/api/jeanp413/open-remote-ssh/0.3.1/file/jeanp413.open-remote-ssh-0.3.1.vsix` |
| VSIX sha256 | `c6f16b225ab86925f2bd9e8cc5ba31e614978ccfa120f1509bdf6e99e5bef13f`                                 |
| Licence     | MIT (`open-remote-ssh/LICENSE.txt`)                                                                |

The `vscode-remote://ssh-remote+<host>/<path>` resolver. It is what makes an
SSH Workspace a Workspace: DevHub opens the workbench on that URI and this
extension answers `onResolveRemoteAuthority:ssh-remote` by connecting over SSH,
installing the remote extension host, and handing back a port.

Its two proposed APIs — `resolvers` and `contribViewsRemote`, as declared by
its own `enabledApiProposals` — are granted in
`scripts/product_metadata.py`. Without the grant the extension host logs
`CANNOT use API proposal: resolvers.` and the authority never resolves.

#### What DevHub changed

The tree above is the published VSIX with the edits in
`scripts/patch_vendored_extensions.py` applied. They make one rule true of this
extension that is true of everything else DevHub sends a host: **it is POSIX
`sh`**. Upstream generates a bash install script and pipes it into `bash -l`; a
host with no bash — BusyBox `/bin/sh`, which is what a NAS has — answered `sh:
bash: not found` and the workspace never resolved. The script is ported
(`patches/open-remote-ssh/0001-posix-server-setup.patch`), the pipe is `sh -l`,
and a failed resolve now carries the remote's own last line of stderr into the
dialog instead of only into an output channel. See `docs/remote-ssh.md`.

Why the edits are committed rather than applied at build time: nothing applies
them at build time, because there is nowhere to. `stage-builtin-extensions.sh`
_symlinks_ each directory here into the built-in set and `package-nightly.py`
copies it — two callers, neither of which can transform a tree the other also
uses without the two of them drifting. So the tree in git is the patched tree,
and `scripts/patch_vendored_extensions_test.py`, which `pnpm test` runs, fails
the build if it stops being.

Two kinds of edit, because there are two kinds of file: a unified diff under
`patches/` for `src/scripts/server-setup.sh`, which a person reads, and an
anchored literal substitution for `lib/extension.js`, a 600 KB bundle on one
line where a line diff would be the file twice and say nothing.

#### To update

1. Fetch the new VSIX and check its sha256 against the table above.
2. Unpack `extension/` over this directory. That puts the tree back to
   upstream and takes DevHub's edits off it.
3. `python3 scripts/patch_vendored_extensions.py --apply`. It re-applies every
   edit and is idempotent; it fails loudly if an anchor moved, which is the
   signal to look at what upstream changed and rewrite that edit.
4. Regenerate any patch you had to rewrite with
   `git diff -- extensions/vendor/open-remote-ssh/src/scripts/server-setup.sh >
extensions/vendor/patches/open-remote-ssh/0001-posix-server-setup.patch`.
5. Reconcile `enabledApiProposals` with the grant table in
   `scripts/product_metadata.py`, and update the version and checksum above.
