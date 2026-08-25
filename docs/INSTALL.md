# Install DevHub 0.1.0

DevHub requires macOS 15 or later on Apple Silicon (arm64). The official
Microsoft Visual Studio Code application is a separate prerequisite: DevHub
does not bundle, download, or redistribute VS Code.

## Install the VS Code CLI (first time)

1. Open the separately installed official VS Code application.
2. Press `Shift-Command-P` and run **Shell Command: Install 'code' command in
   PATH**.
3. Restart the terminal and verify that `code` resolves to one of these paths:

   - `/usr/local/bin/code`
   - `/opt/homebrew/bin/code`

   ```sh
   command -v code
   code --version
   code serve-web --help
   ```

Install DevHub by verifying the adjacent checksum, unzipping the release, and
moving `DevHub.app` to `/Applications` (or another applications folder):

```sh
shasum -a 256 -c DevHub-v0.1.0-macos-arm64.zip.sha256
```

## Reproduce a local package

The release script packages an already-generated `.app`; it does not build,
sign, notarize, publish, or contact a remote service. From a macOS Apple
Silicon checkout, run:

```sh
CI=true pnpm --filter @devhub/app exec tauri build --bundles app
pnpm run package:local-release -- \
  --app target/release/bundle/macos/DevHub.app \
  --output-dir dist/release
```

The script emits the zip, its `.zip.sha256` checksum, and a sorted SHA-256
manifest for the app bundle. The release archive also contains the DevHub
license, the bundled production-dependency notices, and this document.
