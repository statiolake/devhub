# Install DevHub

DevHub requires macOS 15 or later on Apple Silicon (arm64). Nothing else has to
be installed: the application bundle carries its own editor.

## From a nightly release

Every night, `.github/workflows/nightly.yml` packages `main` and replaces the
prerelease tagged `nightly` with a fresh `DevHub-darwin-arm64-<date>-<sha>.zip`.

The build is signed ad-hoc, not by a registered developer, and it is not
notarised, so the browser's quarantine flag has to come off before macOS will
open it. Take it off the *archive*, before unpacking:

1. Download the zip, and clear the flag on the zip file:

   ```sh
   xattr -d com.apple.quarantine ~/Downloads/DevHub-darwin-arm64-*.zip
   ```

   `No such xattr` means the download was never quarantined; carry on.

2. Unzip it (double-clicking is enough; the archive is produced with `ditto`,
   so `ditto -x -k` is the faithful command-line counterpart — plain `unzip`
   writes the bundle's extended attributes out as `._` files beside it).
3. Move `DevHub.app` to `/Applications`, or wherever you keep applications.

Order matters. Whatever unpacks the archive copies the flag onto every file it
writes — 20,000 of them for this app, which is why the usual `xattr -dr` on the
unpacked bundle is the slow way round. Clear it on the one file first and the
extraction has nothing to propagate; there is nothing left to clean up
afterwards.

If you unzipped first, the recursive form is still the way out:

```sh
xattr -dr com.apple.quarantine /Applications/DevHub.app
```

The first launch asks for access to the keychain item "DevHub Safe Storage".
That is the app creating the store the editor keeps secrets in; answer once and
it stops asking.

DevHub has no update mechanism. To update, replace the app with a later
nightly.

## From a local build

The packaging script assembles the same bundle from a built tree, and is the
only supported way to reproduce a release locally:

```sh
scripts/provision-vscode.sh          # the VS Code submodule: deps, patches, compile
pnpm install --frozen-lockfile
pnpm run build                       # apps/desktop and the bridge extension
scripts/package-nightly.py --out-dir dist --zip
```

The result is `dist/DevHub.app` and, with `--zip`, the archive beside it. The
script neither signs with a real identity, notarises, nor publishes anything;
it only fetches what VS Code's own extension build fetches.

`scripts/package-icon.sh` regenerates `distribution/DevHub.icns` from
`assets/icon-master.svg` and `assets/icon-master-small.svg` — the second is the
same mark redrawn for 16 and 32 px, where the first collapses. Run it when the
icon changes and commit the result: packaging uses the committed file, and so
does the bundle a source run boots. It needs ImageMagick (`brew install
imagemagick`) alongside macOS's own `qlmanage` and `iconutil`.

## What is inside

`DevHub.app/Contents/Resources/app` holds DevHub's own main process and App
Shell, and `node_modules/code-oss-dev` holds the pinned VS Code submodule: its
compiled `out/`, its production dependencies, and the built-in extension set,
with DevHub's bridge extension among them. The licences of everything
redistributed are in `DevHub.app/Contents/Resources/licenses`.
