# DevHub, native

A fully native macOS DevHub: Swift, AppKit and SwiftUI, with no TypeScript,
no JavaScript, no Electron and no web views. It aims at the same features and
polish as the TypeScript app's **terminal mode** (`docs/terminal-mode.md` at
the repository root), and is a drop-in replacement for it on the same
profile: the same `settings.toml`, `state.json`, tmux server, control socket
and `devhub` command protocol.

The plan, the feature inventory and the work packages are in
[`docs/PLAN.md`](docs/PLAN.md).

## Layout

| Path | What |
| --- | --- |
| `Package.swift` | SwiftPM package. The App target is declared only on macOS |
| `Sources/DevHubCore` | Foundation-only library: model, config, tmux, git, protocols. Builds on Linux |
| `Sources/DevHubCLI` | The `devhub` command |
| `Sources/DevHubApp` | The AppKit/SwiftUI app (macOS) |
| `Tests/DevHubCoreTests` | XCTest, Linux and macOS |
| `Resources/Info.plist` | Template for the bundle's Info.plist |
| `Scripts/bundle-app.sh` | Builds `build/DevHub.app` |

## Requirements

- macOS 14 or later to run the app; Xcode 16 (Swift 6.0+) to build it.
- Core and the CLI also build on Linux with Swift 6.1 — handy without a Mac:

  ```sh
  docker run --rm -v "$PWD/native":/src -w /src swift:6.1-noble swift build
  docker run --rm -v "$PWD/native":/src -w /src swift:6.1-noble swift test
  ```

  (from the repository root; on Linux `swift build` builds DevHubCore and
  `devhub` only).

## Build, test, run (macOS)

```sh
cd native
swift build                        # Core, CLI and App (debug)
swift test                         # Core tests
swift run DevHubApp                # the app, unbundled (fine for development)
swift run devhub --version

Scripts/bundle-app.sh              # release build -> build/DevHub.app (ad-hoc signed)
open build/DevHub.app
build/DevHub.app/Contents/MacOS/DevHub --self-test   # what CI runs
```

`Scripts/bundle-app.sh --debug` bundles a debug build; `--output DIR` puts the
app elsewhere; `--bundle-id ID` overrides the bundle identifier
(`net.statiolake.devhub.native` by default, so it does not collide with the
TypeScript app in Launch Services while both are installed).

### Running beside the TypeScript app

Both apps use the same locations on the default profile, and only one DevHub
may own a profile's control socket at a time. To run the native app next to
the TypeScript one while developing, give it a profile of its own:

```sh
DEVHUB_PROFILE=native-dev swift run DevHubApp
```

That uses `~/Library/Application Support/DevHub Native Dev`,
`~/.config/devhub-native-dev/settings.toml` and the tmux server
`-L devhub-native-dev` (see `ProfileLocations`).

### A CI build

The `Native` workflow (`.github/workflows/native.yml`) builds and tests on
Linux and macOS for every push to `native-macos` touching `native/`, and
uploads `DevHub-native-<sha>` (a zip of `DevHub.app`). Downloaded apps are
quarantined; ad-hoc signing is not notarisation:

```sh
ditto -x -k DevHub-native.zip . && xattr -dr com.apple.quarantine DevHub.app
```

## Status

Phase 0 (skeleton): an empty window, `devhub --version`, and the Core support
types (profile locations, SHA-256, tmux session names, a process runner).
Everything else is planned in `docs/PLAN.md`.
