# Release a public Apple Silicon app

The first production release is DevHub `0.1.0`, bundle identifier `io.github.statiolake.devhub`, for Apple Silicon on macOS 15 or later. The repository is public at `statiolake/devhub` under the MIT License.

## Consequences

- GitHub Actions uses an arm64 `macos-15` runner for tests, bundle smoke tests, and release construction.
- Release builds use ad-hoc signing without certificate signing or notarization.
- The release artifact is `DevHub-v0.1.0-macos-arm64.zip` with SHA-256 checksum, dependency licenses, and pinned OpenVSCode provenance.
- DMG packaging, Intel support, automatic updates, Windows, and Linux are outside the MVP.
- Installation documentation explains right-click Open and quarantine recovery for an unsigned download.
- Main and pull-request workflows test the product. `v*` tags and manual dispatch build release candidates; a release tag uploads a GitHub Release artifact.
- MVP completion includes creating the public repository, pushing `main`, tagging and pushing `v0.1.0`, waiting for Actions, and confirming a downloadable GitHub Release.
- A reproducible unmodified Darwin arm64 OpenVSCode build is a prerequisite release gate because upstream publishes Linux binaries only.
