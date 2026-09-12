# SSH remote development

Open a folder on another machine and work in it as if it were local: the
workbench stays on your Mac, everything it drives — the terminal, the file
system, extensions, language servers — runs over there.

DevHub does this the way VSCodium does, with two pieces that have never met
before they are asked to talk to each other.

* **Open Remote - SSH**, `jeanp413.open-remote-ssh`, vendored as a built-in
  from Open VSX. It is what resolves `ssh-remote://<host>` authorities. See
  `extensions/vendor/README.md`.
* **The remote extension host**, or REH — VS Code's own server, built from the
  same VS Code commit DevHub's client is built from and published on this
  repository's releases. That is `scripts/build_reh.py` and the `reh-*` jobs in
  `.github/workflows/nightly.yml`.

## What happens when you open a host

1. The extension SSHes in and runs a shell script it generates from
   `src/scripts/server-setup.sh` in its own source.
2. That script reads five things out of DevHub's `product.json` — the client's,
   over the SSH connection's near end — and uses them to work out what to
   fetch and where to put it:

   | key | value | what the remote does with it |
   | --- | --- | --- |
   | `serverDownloadUrlTemplate` | see below | the URL, after substitution |
   | `commit` | the VS Code submodule's HEAD | names the install directory, and is checked against the server's own |
   | `version` | `1.136.1` | substituted as `${version}`, if the template asks |
   | `serverApplicationName` | `devhub-server` | the script it runs: `bin/devhub-server` |
   | `serverDataFolderName` | `.devhub-server` | `$HOME/.devhub-server` on the remote |

3. It downloads the tarball, unpacks it with `tar --strip-components 1` into
   `$HOME/.devhub-server/bin/<commit>/`, and starts
   `bin/devhub-server --start-server --host=127.0.0.1 --port=0 ...`.
4. It reads the port the server printed out of the log, forwards it over the
   SSH connection, and the workbench connects.

The server then checks the connecting client's commit against its own and
refuses if they differ. That is the extension's default,
`remote.SSH.serverValidation: strict`, and it is the reason everything below is
keyed on a commit rather than on a version or a date.

## The URL

Stated once, in `apps/desktop/product-overrides.json`:

```
https://github.com/statiolake/devhub/releases/download/reh-${commit}/devhub-reh-${os}-${arch}-${commit}.tar.gz
```

The remote substitutes six names into a template, with one `sed` each:
`${quality}`, `${version}`, `${commit}`, `${os}`, `${arch}`, `${release}`.
DevHub's uses three of them.

`${os}` is `linux`, `darwin`, `alpine` or `freebsd`, decided by `uname -s` on
the remote (and by `/etc/os-release` for Alpine). `${arch}` is `x64`, `arm64`,
`armhf`, `ppc64le`, `riscv64`, `loong64` or `s390x`, from `uname -m`.

`${quality}` and `${release}` are deliberately not in it. DevHub states neither
key, and a missing one is substituted with the string `undefined` or with
nothing at all rather than reported — a URL that is wrong in a way no error
message mentions. `scripts/build_reh_test.py` fails if either appears.

## What is built, where, and when

`scripts/build_reh.py` produces one tarball per target. Inside it, under a
single directory:

```
devhub-reh-linux-x64/
  bin/devhub-server        the launcher; runs ./node ./out/server-main.js
  bin/remote-cli/devhub    the `code` equivalent, for opening files from the
                           remote's own shell
  node                     the prebuilt Node the server runs on
  out/                     the bundled server
  product.json             DevHub's, with the same `commit` the client states
  extensions/              the built-in set, minus the UI-only ones and
                           minus copilot
  node_modules/            the server's production dependencies
```

**No Copilot.** DevHub pins `chat.disableAIFeatures: true`, so nothing on a
remote would ever start the agent host, and the `copilot` built-in plus its
native runtime are about 470 MB of an 810 MB tree — the tarball is 103 MB with
them gone and 237 MB with them in. `scripts/build_reh.py` deletes them after
the build rather than asking the build not to make them, because there is
nothing to ask: `copilot` is a local workspace extension in the submodule, not
an entry in `product.json`'s `builtInExtensions`, so the product edit the script
already makes cannot reach it; there is no flag or environment variable for it;
and leaving it uncompiled does not work either, because the last step of every
REH package task walks into the output looking for its SDK and throws when it
is not there. Two small packages stay — `@github/copilot` (12 KB) and
`@github/copilot-sdk` (736 KB) — because `server-main.js` reads their versions
at startup. The build runs `bin/devhub-server --version` afterwards whenever the
target is one the building machine can execute, so a deletion that broke
startup fails the build rather than the connection.

Published targets are `linux-x64` and `linux-arm64`. Each is built on a runner
of its own architecture, because `vscode/remote/node_modules` holds native
addons — node-pty, `@parcel/watcher`, kerberos, `@vscode/spdlog` — and the
package task ships them as npm installed them, for the machine that did the
installing. Cross-building produces a tarball that unpacks, starts, and then
fails to open a terminal.

`darwin-arm64` is not published yet, for the same reason and one more: it would
have to be built on the macOS job, which already runs for two hours against a
two-hour timeout. SSHing into a Mac is rare enough to wait.

**When**: the server is a function of the VS Code submodule, not of DevHub's
own commits, so it is rebuilt when the submodule moves — roughly monthly —
and not nightly. `reh-decide` in the nightly workflow asks GitHub whether the
release named after the current submodule commit exists, and the whole thing
costs a minute on the nights it does.

**The one thing that does not follow**: a change to `patches/vscode/` that
touches server code does not move the submodule, so it does not change
`${commit}`, so remotes go on using the server already published under that
tag. Rebuild it deliberately — Actions → Nightly → Run workflow, with
`force_reh` ticked.

## Building one locally

```sh
scripts/build_reh.py linux-x64            # writes dist/devhub-reh-linux-x64-<commit>.tar.gz
```

It provisions the submodule first unless you pass `--skip-provision`, and it
edits `vscode/product.json` for the duration of the build and puts it back
afterwards. That edit is not avoidable: esbuild inlines `product.json` into
the server bundle, so a server bundled against the submodule's own file calls
itself `code-server-oss` no matter what the `product.json` next to it says.

On a Mac the Linux tarballs it produces are for inspecting the layout, not for
running: the Node inside is downloaded for the target, but the native addons
beside it are the Mac's. Use CI for anything you intend to connect to. The one
target a Mac builds correctly is `darwin-arm64`, which is also the one CI does
not publish.

The tarballs are around 100 MB: 103 MB for linux-x64, 99 MB for linux-arm64,
94 MB for darwin-arm64.

## A source run cannot connect

`pnpm dev` has no `commit` — deliberately, and it cannot be given one: VS Code
reads `product.commit` as "this is a packaged build" and sends a source run
looking for a `node_modules.asar` that a checkout does not have. But `commit`
is also what the extension puts in the download URL and what the remote server
checks the connecting client against, so a source run asks for
`devhub-reh-linux-x64-undefined.tar.gz` and gets a 404.

**SSH workspaces need a packaged build.** Test them against `pnpm build`'s
`dist/DevHub.app` or a nightly, not against `pnpm dev`. See
`scripts/product_metadata.py` for why the field means what it means.

## Installing a server by hand

For a remote with no route to github.com, or to try a server the nightly has
not published.

```sh
# on your Mac: the commit DevHub will ask for
commit=$(git -C vscode rev-parse HEAD)

# on the remote
mkdir -p ~/.devhub-server/bin/$commit
tar -xzf devhub-reh-linux-x64-$commit.tar.gz \
    --strip-components 1 -C ~/.devhub-server/bin/$commit
```

The extension looks for `bin/devhub-server` under that exact directory and
skips the download when it finds it. Nothing else about the flow changes.

If the commit has to differ — you are running a DevHub built from a different
submodule than the server you have — say so explicitly rather than renaming the
directory: `"remote.SSH.serverValidation": "force"` rewrites the server's
`product.json` to match the client. It is a way to get connected, not a way to
be sure the two halves agree.

## Pointing one host somewhere else

`remote.SSH.serverDownloadUrlTemplate` overrides the product's template for
every host. There is no per-host form of it; a host that needs its own server
gets it installed by hand, above.

## Where to look when it does not connect

The extension logs the whole install script and its output to **Output → Remote
- SSH**. Everything the remote decided is in there: the URL it built, whether
the download succeeded, and the server's own log path
(`~/.devhub-server/.<commit>.log`) if it started and then failed.
