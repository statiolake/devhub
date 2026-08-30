# Install DevHub

DevHub requires macOS 15 or later on Apple Silicon (arm64). Nothing else has to
be installed: the application bundle carries its own editor.

## From a nightly release

Every night, `.github/workflows/nightly.yml` packages `main` and replaces the
prerelease tagged `nightly` with a fresh `DevHub-darwin-arm64-<date>-<sha>.zip`.

1. Download the zip from the release page and unzip it (double-clicking is
   enough; the archive is produced with `ditto`).
2. Move `DevHub.app` to `/Applications`, or wherever you keep applications.
3. Clear the quarantine flag. The build is signed ad-hoc, not by a registered
   developer, and it is not notarised, so macOS refuses to open it until you
   say otherwise:

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
`assets/icon-master.svg`. Run it when the icon changes and commit the result —
packaging uses the committed file.

## What is inside

`DevHub.app/Contents/Resources/app` holds DevHub's own main process and App
Shell, and `node_modules/code-oss-dev` holds the pinned VS Code submodule: its
compiled `out/`, its production dependencies, and the built-in extension set,
with DevHub's bridge extension among them. The licences of everything
redistributed are in `DevHub.app/Contents/Resources/licenses`.
