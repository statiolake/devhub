# THROWAWAY: OpenVSCode Darwin arm64 feasibility results

Date of local run: 2026-08-22  
Host: macOS 26.5 (`25F71`), arm64  
Source: `gitpod-io/openvscode-server`, tag
`openvscode-server-v1.109.5`, commit
`4ffe2270acdf711bbefecc3e8c79f4b3631640e5`

This report records a bounded feasibility spike. It is evidence for a build
and packaging decision, not a production implementation.

## Recommendation

**Accept upstream source-build feasibility for a host integration, with an
explicit local packaging/signing step. Do not expect or depend on an official
Darwin release asset. Do not fork or modify OpenVSCode.**

The source build and server smoke passed on this arm64 Mac. The official
release still publishes Linux-only binary archives, and this spike did not
produce a signed app bundle. A DevHub distribution would therefore own the
Darwin build, bundle, signing, notarization, update, and resource policies.

The OpenVSCode workbench and Integrated Terminal remain upstream and
unrestricted. Any future local fork is limited to Tauri/WRY host integration;
this spike made no OpenVSCode source change.

## Pass/fail matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Pin official stable source | PASS | Tag and commit above; clone remained clean (`git status --short`). |
| Official Darwin release asset | NOT AVAILABLE | Release API lists Linux `x64`, `arm64`, `armhf` archives only; no Darwin/macOS asset. |
| Node/toolchain pin | PASS | `.nvmrc` is `22.21.1`; official Node Darwin arm64 archive checksum matched `c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af`. |
| Dependency install | PASS | Node `v22.21.1`, npm `10.9.4`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, recursive `npm ci`; 1501 packages added, no install error. |
| Official arm64 server/web build | PASS | `npm run gulp -- vscode-reh-web-darwin-arm64`; compile reported 0 errors and the task completed in about 11 minutes. |
| Artifact architecture | PASS | Embedded `node` and `node-pty`/`@parcel/watcher` native addons are Mach-O arm64; `lipo -info` reports non-fat arm64. |
| Entrypoint help | PASS | `bin/openvscode-server --help` with explicit writable data dirs exited 0 and identified version 1.109.5. |
| Authenticated loopback | PASS | `127.0.0.1:18434`: unauthenticated request 403; token query plus cookie flow 200, 2417-byte HTML response. |
| GUI/workbench behavior | NOT RUN | This independent spike intentionally did no GUI wait or Tauri embedding. |
| `.app` packaging/signing/notarization | NOT RUN | Build output is a server directory only. |
| GitHub `macos-15` reproduction | NOT VERIFIED | The checked-in official Darwin path is Azure macOS Sequoia, not a GitHub `macos-15` job. |

## Exact build evidence

All large files were kept under:

```text
/private/tmp/openvscode-darwin-arm64-feasibility/
```

The successful artifact was:

```text
/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64
```

Its measured size was approximately `248 MB`, including approximately:

```text
node          107 MB
out            44 MB
extensions    56 MB
node_modules  42 MB
```

Representative architecture output:

```text
node:          Mach-O 64-bit executable arm64
pty.node:      Mach-O 64-bit bundle arm64
watcher.node:  Mach-O 64-bit bundle arm64
Non-fat file ... is architecture: arm64
```

The final server package contained `bin/openvscode-server`, the embedded
Node 22 runtime, `out/server-main.js`, web assets, built-in extensions, and
native addons. The shell entrypoint itself is expectedly a script rather than
a Mach-O file.

The build graph is upstream. `build/gulpfile.reh.ts` declares
`{ platform: 'darwin', arch: 'arm64' }`, and derives the
`vscode-reh-web-darwin-arm64` and `vscode-reh-web-darwin-arm64-min-ci` tasks.
The official Darwin compile pipeline uses the `-min-ci` variant, sets
`VSCODE_ARCH=arm64`, installs Node from `.nvmrc`, runs `npm ci` with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`, then archives the server-web directory.

## Release asset evidence

The official v1.109.5 release metadata is at
[`api.github.com/repos/gitpod-io/openvscode-server/releases/tags/openvscode-server-v1.109.5`](https://api.github.com/repos/gitpod-io/openvscode-server/releases/tags/openvscode-server-v1.109.5).
The binary assets observed there were:

```text
openvscode-server-v1.109.5-linux-arm64.tar.gz
openvscode-server-v1.109.5-linux-armhf.tar.gz
openvscode-server-v1.109.5-linux-x64.tar.gz
```

No `darwin`, `macos`, or `.app` asset was present. The source release page is
[`github.com/gitpod-io/openvscode-server/releases`](https://github.com/gitpod-io/openvscode-server/releases).

## Negative control: wrong Node version

The host initially had Node `v26.7.0`. Running `npm ci` with that version
failed in the native `tree-sitter` build because the Node 26 headers require
C++20 while that dependency's invocation did not enable it; the compiler
reported `v8config.h: "C++20 or later required"` and concepts errors. This is
why the successful run used the upstream `.nvmrc` Node `22.21.1` rather than
the host default. It is a reproducibility requirement, not a source failure.

The first Node 22 install attempt also tried to download Playwright's browser;
rerunning with the upstream CI environment's
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` completed successfully. No GUI browser
download is needed for this server package build.

## Loopback smoke details

The smoke launched the generated entrypoint with:

```text
--host 127.0.0.1
--port 18434
--connection-token-file <private mode-600 temporary file>
--accept-server-license-terms
--server-data-dir <private temporary directory>
--user-data-dir <private temporary directory>
--log error
```

The unauthenticated status was `403`. The token query establishes the
server's cookie authentication; following that cookie with `curl` returned
HTTP `200` and a 2417-byte workbench HTML response. Token, cookie, response,
and log files were temporary and removed; no credential is reproduced here.
This is only a process/HTTP smoke, not proof of Tauri child-WebView keyboard
routing or OpenVSCode workbench behavior.

## GitHub macos-15 reproducibility

The source tree has GitHub workflows, but this tag has no checked-in GitHub
Actions job for this server build using `macos-15`. The official Darwin
pipeline is Azure Pipelines (`AcesShared`, macOS Sequoia image), with
`VSCODE_ARCH=arm64` and a 90-minute CI job timeout. The build recipe itself is
portable enough to try on a GitHub arm64 runner:

1. Check `uname -m`, Xcode/clang, Python, and disk/RAM.
2. Install/select Node `22.21.1` from `.nvmrc`.
3. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.
4. Run `npm ci`, then `npm run gulp vscode-reh-web-darwin-arm64-min-ci`.
5. Run `file`/`lipo -info` over every Mach-O object and archive the output.

The GitHub `macos-15` label, architecture, hosted image capacity, signing
secrets, and exact runner behavior were not verified in this spike. Therefore
GitHub reproducibility is **plausible but unverified**, not a pass.

## App-bundle inclusion plan (not implemented)

If DevHub packages this server, embed the complete generated directory below
the app resources, for example:

```text
DevHub.app/Contents/Resources/openvscode-server/
```

The host process should launch it on loopback with a stable persisted loopback
port selected after the initial setup and a mandatory connection token file
stored in an app-support directory. It should give the server explicit
server-data and user-data directories, retain the
embedded `node` and native `.node` modules, and avoid logging authenticated
URLs. The nested Mach-O files must be signed before the outer `.app` is signed
and notarized. Update delivery must replace the whole pinned payload rather
than mutate it in place.

No `.app`, `Info.plist`, entitlements, code signature, notarization, updater,
or resource budget was produced here.

## Unresolved risks and explicit non-claims

- No official Darwin binary distribution exists for this tag; every DevHub
  release would own source builds and Apple signing/notarization.
- No Tauri `NSWindow`/child `WKWebView` test was performed in this spike. The
  separate Tauri prototype owns that question.
- No real workbench command-key matrix (`Cmd+P`, `Cmd+Shift+P`, `Cmd+S`,
  `Cmd+Z`, `Cmd+C/V`) was claimed here.
- No `?ew=true` plus `?folder=...` multi-client, hidden-workbench retention,
  IME, hot-exit, unsaved-editor, or WebSocket longevity test was claimed here.
- No one/three/five-workbench resource measurement was performed.
- No connection-token rotation, crash recovery, process sandboxing, or
  security-boundary review was performed beyond the loopback/token smoke.
- No app bundle, signing, notarization, entitlements, installer, updater, or
  release artifact was created.
- The build was run on one macOS arm64 host. Other Xcode, SDK, Python, and
  native-addon combinations remain to be checked.
