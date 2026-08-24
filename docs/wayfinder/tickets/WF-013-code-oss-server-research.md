---
id: WF-013
title: Verify the upstream Code-OSS Server/Web provider
status: closed
parent: WF-003
type: research
labels:
  - wayfinder:research
---

## Question

Does the upstream MIT Code-OSS repository already contain the Server/Web
implementation needed by DevHub, including a macOS arm64 production target, or
is Gitpod OpenVSCode still required as the server implementation? Is a fresh
Code-OSS build a cleaner provider than the user-installed official VS Code Web
provider?

## Resolution

Yes: upstream Code-OSS contains the complete Server/Web path. In the current
1.134 generation, `src/server-main.ts` owns the HTTP and WebSocket server and
delegates to the remote Extension Host Agent, while `scripts/code-server.sh`
and `scripts/code-server.js` are the development entrypoints. The upstream
build graph includes `vscode-reh-web-darwin-arm64[-min]` and packages the
server as `code-server-oss`. Its `product.json` declares the source and server
license as MIT.

The local macOS arm64 proof installed the DevHub Bridge VSIX, activated it in
the Code-OSS Extension Host, and completed the authenticated
`hello`/`hello_accepted`/`state_snapshot` handshake. A temporary-folder Web
run showed the normal Restricted Mode Workspace Trust banner. The only build
limitation was the official packaging task's Copilot SDK preparation: the
official CI downloads a Copilot VSIX first, while this uncredentialed local
reproduction did not. The server/Web artifact was nevertheless produced far
enough to run the real Workbench.

Recommendation: keep the separately installed official VS Code `serve-web`
provider as DevHub's primary/default provider because it receives Microsoft's
updates without DevHub redistributing an application. Treat plain Code-OSS as
a clean future provider (and a possible replacement for the old OpenVSCode
fallback), not as an immediate migration. Code-OSS removes the need for a
Gitpod fork to obtain Server/Web functionality, but it does not remove the
distribution work: DevHub would own extension provisioning, product policy,
monthly upstream builds, native dependencies, macOS artifacts, provenance,
and smoke tests.

## Source and version boundary

The upstream repository explicitly describes Code-OSS as MIT source and VS
Code as a separate Microsoft-customized distribution under a product license
in its [1.134.0 README](https://github.com/microsoft/vscode/blob/1.134.0/README.md).
The relevant source tag is `1.134.0` at commit
`474a349ad5b745e512ef86b864d1c74f7264dd7a`. That tag currently contains the
next package version (`1.135.0`) after the version bump, so the actual build
below uses the matching `release/1.134` commit
`110a328ea54b42367b803ec53ee0bf52ef26b419`, which is also the commit reported
by the locally installed VS Code 1.134.0 arm64 application. The tag and release
branch have the same Server/Web architecture and build task names; the branch
was used to avoid claiming that the tag's post-bump package is the installed
release.

The comparison baseline is the repository's pinned Gitpod
`openvscode-server-v1.109.5` at commit
`4ffe2270acdf711bbefecc3e8c79f4b3631640e5`, compared with Microsoft's
same-version Code-OSS `1.109.5`. This is a source comparison, not a claim that
OpenVSCode has a current 1.134 release.

## Findings

### 1. Code-OSS has the Server/Web implementation

The upstream [server entrypoint](https://github.com/microsoft/vscode/blob/1.134.0/src/server-main.ts)
creates a Node HTTP server, routes ordinary requests to the remote Extension
Host Agent, upgrades WebSocket connections, binds the requested host/port, and
prints the Extension Host Agent listening address. The server code also owns
the server-license acceptance boundary. The [shell entrypoint](https://github.com/microsoft/vscode/blob/1.134.0/scripts/code-server.sh)
prepares the source tree and Node runtime, then invokes
[`scripts/code-server.js`](https://github.com/microsoft/vscode/blob/1.134.0/scripts/code-server.js);
the latter starts `out/server-main.js`, supports `--launch`, and waits for the
`Web UI available at` marker.

This is the same topology the upstream contribution guide calls Code Server
Web: the UI runs in a browser and extensions run in NodeJS. The
[contribution guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
documents `./scripts/code-server.sh --launch` for that mode.

### 2. macOS arm64 is an upstream server-web build target

The upstream [REH build graph](https://github.com/microsoft/vscode/blob/1.134.0/build/gulpfile.reh.ts)
contains `darwin/arm64` in `BUILD_TARGETS`, includes server and browser-web
entrypoints, and generates the task
`vscode-reh-web-darwin-arm64-min-ci`. Its package task stamps `product.json`,
copies the bundled extensions, emits the server entrypoints, and renames the
platform launcher to `bin/${product.serverApplicationName}`.

The [Darwin CI pipeline](https://github.com/microsoft/vscode/blob/1.134.0/build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml)
executes `core-ci`, then `vscode-reh-web-darwin-$(VSCODE_ARCH)-min-ci`, moves
the result to `vscode-server-darwin-$(VSCODE_ARCH)-web`, smoke-tests the arm64
server path, and publishes a `vscode-server-darwin-arm64-web.zip` artifact.
Therefore a macOS arm64 Code-OSS server is not a Gitpod-only packaging trick;
it is an upstream build target. DevHub would still need its own reproducible
build and release/provenance policy if it redistributed that artifact.

### 3. Plain Code-OSS product configuration is MIT but intentionally minimal

The upstream [1.134.0 `product.json`](https://github.com/microsoft/vscode/blob/1.134.0/product.json)
sets:

```text
nameShort             Code - OSS
applicationName       code-oss
licenseName           MIT
serverLicenseUrl      microsoft/vscode LICENSE.txt
serverLicense         []
serverApplicationName code-server-oss
serverDataFolderName  .vscode-server-oss
tunnelApplicationName code-tunnel-oss
```

The source product has no `extensionsGallery`/Microsoft Marketplace service
configuration. Its built-in product list names the open-source JavaScript
debug companion, JavaScript debugger, and JavaScript profile-table
extensions. The server package produced by the local build contained the
`code-server-oss` launcher and no `code-tunnel` binary. The product still has a
`tunnelApplicationName` field and the source contains the open tunnel-forwarding
extension; that is not the Microsoft tunnel service or tunnel executable.

This distinction matters for licensing and feature expectations: MIT covers
the Code-OSS source and its own open-source built-ins, not the Microsoft
Marketplace, Microsoft's proprietary VSIXes, Copilot VSIX delivery, or the
official tunnel service. A DevHub Code-OSS provider must deliberately choose
Open VSX, an internal gallery, or local VSIX provisioning. The DevHub Bridge
already works as a local VSIX, so a gallery is not required for the first
provider slice.

## Local Code-OSS build and runtime proof

All source checkouts, Node downloads, build output, server data, user data, and
extension data were kept under `/private/tmp`/the macOS temporary directory;
no build output was added to the repository. The proof used Node 24.18.0
darwin-arm64, matching the `release/1.134` `.nvmrc` requirement.

The bounded build commands were:

```sh
PATH="$ROOT/node-v24.18.0-darwin-arm64/bin:$PATH" \
NPM_CONFIG_CACHE="$ROOT/npm-cache" npm ci

PATH="$ROOT/node-v24.18.0-darwin-arm64/bin:$PATH" \
NPM_CONFIG_CACHE="$ROOT/npm-cache" npm run gulp core-ci

PATH="$ROOT/node-v24.18.0-darwin-arm64/bin:$PATH" \
NPM_CONFIG_CACHE="$ROOT/npm-cache" \
npm run gulp vscode-reh-web-darwin-arm64-min-ci
```

`npm ci` and `core-ci` succeeded. The direct non-CI web task stopped in the
official private-field mangling guard; the CI task got through bundling and
packaging, then stopped at
`prepareBuiltInCopilotRipgrepShim` because the Copilot SDK directory was
absent. The exact local failure is recorded in the temporary
`reh-web-package-ci.log` as:

```text
Copilot SDK directory not found at .../vscode-reh-web-darwin-arm64/extensions/copilot/node_modules/@github/copilot/sdk
```

This is an honest source/build distinction, not a source edit or a claim of a
clean official release build. The CI template downloads Copilot before
packaging in the [same upstream pipeline](https://github.com/microsoft/vscode/blob/1.134.0/build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml);
the local run had no Microsoft build credentials or Copilot artifact. The
partial package was approximately 501 MiB and contained `bin/code-server-oss`,
`out/server-main.js`, the browser Workbench resources, `product.json`, and the
bundled open-source extensions.

The package's isolated CLI proof was:

```text
$ code-server-oss --version
1.134.0
110a328ea54b42367b803ec53ee0bf52ef26b419
arm64

$ code-server-oss --list-extensions --show-versions ...
devhub.devhub-bridge@0.1.0
```

The server was started with a loopback host, random port, connection token,
isolated server-data directory, isolated user-data directory, isolated
extensions directory, and telemetry disabled. It reported:

```text
Server bound to 127.0.0.1:56081 (IPv4)
Extension host agent listening on 56081
Web UI available at http://localhost:56081?tkn=<token>
Extension host agent started.
```

An unauthenticated HTTP request returned `403 Forbidden`; the token URL first
returned `302` with the `vscode-tkn` cookie, and the cookie-following request
returned `200 OK` with the Workbench HTML. Loading that authenticated URL in
the in-app browser showed `Welcome — Code - OSS`, proving the browser client
and server package were both live.

### Bridge activation and handshake

The existing DevHub VSIX was installed into the isolated Code-OSS extensions
directory with `code-server-oss --install-extension <bridge.vsix>`. After the
Workbench loaded, the real remote Extension Host log contained:

```text
ExtensionService#_doActivateExtension devhub.devhub-bridge,
  startup: true, activationEvent: '*'
```

The temporary loopback test host then recorded the protocol sequence:

```text
kind: hello
event: hello_accepted
kind: state_snapshot
payload: { readiness: "ready", context: { kind: "global" }, dirty: false }
```

The `hello_accepted` surface ID matched the registry entry supplied to the
Bridge. This is a real Code-OSS Extension Host activation and authenticated
Bridge handshake, not merely an HTTP or TCP readiness probe.

### Workspace Trust

The folderless/global run showed no trust prompt and the Bridge snapshot had
`context.kind = global`. A second isolated server started with
`--default-folder <temporary-folder>` loaded the same Code-OSS Workbench with
the banner:

```text
Restricted Mode is intended for safe code browsing. Trust this folder to enable all features.
```

The status bar also showed `Restricted Mode`, and the Chat model control was
unavailable while restricted. Code-OSS therefore keeps Workspace Trust as a
Workbench concern; the provider proof did not silently trust a folder or
disable the warning. The Bridge handshake above was intentionally the
folderless/global case; a trusted-folder handshake is not needed to establish
that the server Extension Host can discover and activate the VSIX.

## Same-version Code-OSS versus Gitpod OpenVSCode

The pinned Gitpod tag is a downstream distribution, not merely a renamed
binary. A same-version tracked-file comparison between Microsoft's
[`1.109.5` source](https://github.com/microsoft/vscode/tree/1.109.5) and
Gitpod's [`openvscode-server-v1.109.5` source](https://github.com/gitpod-io/openvscode-server/tree/openvscode-server-v1.109.5)
found four Gitpod-only files (`.gitpod.Dockerfile`, `.gitpod.yml`,
`scripts/sync-helper.js`, and `scripts/sync-with-upstream.sh`) and content
changes in these concrete categories:

| Area | Gitpod delta at the same 1.109.5 version | Ownership consequence |
| --- | --- | --- |
| Server defaults | [`src/server-main.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/server-main.ts) changes the default port from 8000 to 3000. [`src/vs/server/node/server.main.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/vs/server/node/server.main.ts) gives `--user-data-dir` separate semantics. | Product defaults and data isolation are downstream policy, not missing upstream server functionality. |
| Web/server behavior | [`src/vs/code/browser/workbench/workbench.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/vs/code/browser/workbench/workbench.ts) forces `remoteAuthority` to the browser host; [`src/vs/server/node/webClientServer.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/vs/server/node/webClientServer.ts) disables the server's web-extension gallery route. | These are maintainable downstream patches, but current upstream already has the Server/Web topology. |
| Extension policy | [`extensionManagementService.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/vs/platform/extensionManagement/node/extensionManagementService.ts) disables signature verification; [`extensionsProposedApi.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/src/vs/workbench/services/extensions/common/extensionsProposedApi.ts) enables proposed APIs for all extensions; Gitpod's [`Git package`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/extensions/git/package.json) disables `git.continueInLocalClone`. | OpenVSCode trades upstream defaults for a server distribution policy. DevHub should not inherit these changes accidentally. |
| Product config/Open VSX | Gitpod's [`product.json`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/product.json) changes names, data folders, issue URLs, built-in/recommendation metadata, and configures `https://open-vsx.org/vscode/gallery` plus resource templates. | This is the main distribution value: a usable gallery and product identity. Plain Code-OSS has no gallery field and needs DevHub-owned provisioning. |
| Build/release | Gitpod adds `server:init` and `server:smoketest` in [`package.json`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/package.json), development product injection in [`build/lib/compilation.ts`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/build/lib/compilation.ts), and Gitpod Docker/workspace files. Its [`sync-with-upstream.sh`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/scripts/sync-with-upstream.sh) rebases a downstream branch; [`sync-helper.js`](https://github.com/gitpod-io/openvscode-server/blob/openvscode-server-v1.109.5/scripts/sync-helper.js) maps extensions to Open VSX and filters a list of proprietary Microsoft extensions. | A downstream fork still carries patch rebases, product synchronization, extension registry validation, release builds, and artifact support. |

The same-version diff is the key answer to “is OpenVSCode technically
redundant?” For the **server implementation**, yes: the upstream Code-OSS
server-main, code-server scripts, REH-Web bundle, and macOS arm64 packaging
are now present upstream. For the **distribution**, no: OpenVSCode supplies
Open VSX configuration, product identity, extension filtering, and a release
process. Those are provider policy choices rather than a missing Server/Web
core.

## Provider comparison and DevHub ownership

| Provider | What is supplied | What DevHub must own | Recommendation |
| --- | --- | --- | --- |
| Official BYO `code serve-web` | User-installed Microsoft VS Code, Microsoft’s update cadence, Marketplace/product services, and the supported Web CLI. | Executable discovery/capability probing, explicit server-license consent, isolated server data, Bridge VSIX installation, readiness/recovery, and WebViews. No monthly binary build or redistribution. | Primary/default now; this is the lowest operational burden and preserves automatic updates. |
| Plain upstream Code-OSS | MIT source, `server-main`, Node Extension Host, browser Workbench, `code-server-oss`, and upstream macOS arm64 REH-Web build target. | Monthly upstream build, Node/native dependency toolchain, product configuration, Open VSX/private-gallery or VSIX provisioning, removal/replacement policy for proprietary build steps, Bridge/trust/HTTP smoke tests, arm64 artifact signing and provenance, and extension license inventory. | Clean future owned provider; a credible replacement for the old OpenVSCode fallback after release gates. |
| Gitpod OpenVSCode | A downstream product with Open VSX configuration, server-oriented defaults/patches, and Gitpod release packaging. | Gitpod patch rebases and release availability; Darwin arm64 is a separate build/provenance problem for the pinned release. | Keep only as the current legacy fallback while Code-OSS/official providers are evaluated; no longer needed to obtain Server/Web code. |

The MIT answer is therefore “safer at the source-license boundary,” not “free
of product obligations.” A Code-OSS artifact can be DevHub-owned and
redistributed under the upstream MIT terms, but the artifact must not silently
reintroduce Microsoft's Marketplace, Copilot VSIX, tunnel service, or other
proprietary distribution pieces. The local Copilot packaging failure is a
practical reminder that a reproducible Code-OSS provider needs an explicit
policy for those components.

## Reproduction evidence and limits

- No source edits were made to either checkout.
- The output was a partial build because the official package task expected the
  separately downloaded Copilot SDK; `core-ci`, bundling, server launch, HTTP
  authentication, browser Workbench load, Bridge activation, and full protocol
  handshake were proven.
- The proof used a folderless/global Bridge run and a separate temporary-folder
  Workspace Trust run. It did not claim a trusted-folder Bridge handshake.
- No DevHub provider migration or production file was made. The report is the
  only repository change from this research task; `prototypes/` and the dirty
  Q5 files were left untouched.
