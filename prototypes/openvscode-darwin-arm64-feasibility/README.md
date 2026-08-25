# THROWAWAY: OpenVSCode Server Darwin arm64 feasibility

This directory is a throwaway build spike. It answers one narrow question:

> Can the upstream OpenVSCode Server `v1.109.5` source be built and packaged
> as a macOS arm64 server artifact without forking or changing OpenVSCode?

The answer from this spike is **yes for a source build**, but **no official
macOS/Darwin release asset is published**. The output is a server directory,
not a signed `.app` bundle.

No OpenVSCode source was changed. The clone, `node_modules`, intermediate
build output, and final artifact are intentionally outside this repository in
`/private/tmp/openvscode-darwin-arm64-feasibility/`. Nothing from that tree is
part of the DevHub product architecture. This is not a production packaging
recipe.

The OpenVSCode workbench and its integrated terminal remain upstream and
unrestricted in this spike. DevHub must not fork or modify the OpenVSCode
workbench; only a host-side Tauri/WRY integration may be locally forked if a
separate host-input experiment proves that necessary.

## Pins and primary sources

- Upstream repository: [gitpod-io/openvscode-server](https://github.com/gitpod-io/openvscode-server)
- Tag: `openvscode-server-v1.109.5`
- Commit: `4ffe2270acdf711bbefecc3e8c79f4b3631640e5`
- Release metadata: [v1.109.5 GitHub API response](https://api.github.com/repos/gitpod-io/openvscode-server/releases/tags/openvscode-server-v1.109.5)
- Host: macOS `26.5` (`25F71`), Darwin arm64
- Required Node pin: `.nvmrc` = `22.21.1`
- Successful local runtime: Node `v22.21.1`, npm `10.9.4`
- Successful build task: `vscode-reh-web-darwin-arm64`

The release API lists three binary assets: Linux `x64`, `arm64`, and `armhf`.
There is no `darwin`, `macos`, or `.app` asset. The release's source archives
are not binary builds.

The upstream build graph nevertheless contains Darwin arm64 targets in
`build/gulpfile.reh.ts`. The upstream Darwin pipeline in
`build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml` builds
`vscode-reh-web-darwin-$(VSCODE_ARCH)-min-ci`, with `VSCODE_ARCH=arm64`, and
archives the resulting server directory. The top-level pipeline uses the
Azure `AcesShared` macOS Sequoia pool, not GitHub Actions.

## Reproduce in an isolated temporary tree

These commands are the exact shape of the successful run. Keep all paths under
`/private/tmp`; do not copy the clone or generated output into `devhub`.

```sh
SPIKE_ROOT=/private/tmp/openvscode-darwin-arm64-feasibility
mkdir -p "$SPIKE_ROOT"

git clone --branch openvscode-server-v1.109.5 --depth 1 \
  https://github.com/gitpod-io/openvscode-server.git \
  "$SPIKE_ROOT/source"
cd "$SPIKE_ROOT/source"
git rev-parse HEAD

# Download the upstream Node arm64 binary matching .nvmrc.
curl -fsSLO \
  https://nodejs.org/dist/v22.21.1/node-v22.21.1-darwin-arm64.tar.gz
grep 'node-v22.21.1-darwin-arm64.tar.gz' build/checksums/nodejs.txt
shasum -a 256 node-v22.21.1-darwin-arm64.tar.gz
tar -xzf node-v22.21.1-darwin-arm64.tar.gz -C "$SPIKE_ROOT"
export PATH="$SPIKE_ROOT/node-v22.21.1-darwin-arm64/bin:$PATH"
node --version
npm --version

# These are the upstream CI download controls. The successful local install
# required PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; ELECTRON_SKIP... matches the
# upstream Darwin pipeline and avoids an unrelated Electron download.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci

# Full, non-minified server-with-web package used by this spike.
npm run gulp -- vscode-reh-web-darwin-arm64
```

The upstream CI-equivalent packaging task is:

```sh
npm run gulp vscode-reh-web-darwin-arm64-min-ci
```

The official pipeline then moves the result to a server name and creates a
zip. This spike used the full task above so the feasibility result includes the
complete web workbench and extensions. The successful artifact was:

```text
/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64
```

It was approximately `248 MB` and contained the embedded Node runtime,
server JavaScript, web resources, built-in extensions, and native modules.

## Artifact checks

Run these checks after the build. The shell wrapper is not a Mach-O binary, so
inspect the embedded Node runtime and representative native addons:

```sh
ARTIFACT="$SPIKE_ROOT/vscode-reh-web-darwin-arm64"
file "$ARTIFACT/node" \
  "$ARTIFACT/node_modules/node-pty/build/Release/pty.node" \
  "$ARTIFACT/node_modules/@parcel/watcher/build/Release/watcher.node" \
  "$ARTIFACT/bin/openvscode-server"
lipo -info "$ARTIFACT/node" \
  "$ARTIFACT/node_modules/node-pty/build/Release/pty.node" \
  "$ARTIFACT/node_modules/@parcel/watcher/build/Release/watcher.node"
```

Observed result:

```text
node:       Mach-O 64-bit executable arm64
pty.node:   Mach-O 64-bit bundle arm64
watcher.node: Mach-O 64-bit bundle arm64
Non-fat file ... is architecture: arm64
```

The packaged `product.json` reports `OpenVSCode Server 1.109.5`,
`applicationName: openvscode-server`, and
`darwinBundleIdentifier: openvscode.server`.

## Non-GUI command and loopback smoke

Use explicit writable data directories. This avoids accidentally writing to a
developer's home directory during a smoke test.

```sh
mkdir -p "$SPIKE_ROOT/runtime-help/server-data" \
  "$SPIKE_ROOT/runtime-help/user-data"
"$ARTIFACT/bin/openvscode-server" \
  --server-data-dir "$SPIKE_ROOT/runtime-help/server-data" \
  --user-data-dir "$SPIKE_ROOT/runtime-help/user-data" \
  --help
```

This exited `0` and began with `OpenVSCode Server 1.109.5`.

The authenticated loopback smoke used a private, mode-600 token file, bound
to `127.0.0.1`, and a cookie jar. Do not paste the token or the server's
printed authenticated URL into logs:

```sh
mkdir -p "$SPIKE_ROOT/runtime-smoke/server-data" \
  "$SPIKE_ROOT/runtime-smoke/user-data"
umask 077
openssl rand -hex 32 > "$SPIKE_ROOT/runtime-smoke/token"

"$ARTIFACT/bin/openvscode-server" \
  --host 127.0.0.1 \
  --port 18434 \
  --connection-token-file "$SPIKE_ROOT/runtime-smoke/token" \
  --accept-server-license-terms \
  --server-data-dir "$SPIKE_ROOT/runtime-smoke/server-data" \
  --user-data-dir "$SPIKE_ROOT/runtime-smoke/user-data" \
  --log error > "$SPIKE_ROOT/runtime-smoke/server.log" 2>&1 &
SERVER_PID=$!

# Poll for at most 30 seconds; do not wait indefinitely.
for i in {1..30}; do
  HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:18434/ || true)"
  [ "$HTTP_STATUS" = 403 ] && break
  sleep 1
done

TOKEN="$(tr -d '\n' < "$SPIKE_ROOT/runtime-smoke/token")"
curl -sS -c "$SPIKE_ROOT/runtime-smoke/cookies" \
  -b "$SPIKE_ROOT/runtime-smoke/cookies" -L \
  -o "$SPIKE_ROOT/runtime-smoke/body" \
  -w 'final_http=%{http_code} body_bytes=%{size_download}\n' \
  "http://127.0.0.1:18434/?tkn=$TOKEN"

kill "$SERVER_PID"
```

Observed: unauthenticated HTTP `403`; token query followed by the server's
cookie authentication flow returned HTTP `200` and a `2417` byte HTML body.
The token, cookie, body, and server log used for this spike were kept in
`/private/tmp` and removed after the test. Never replace the connection token
with `--without-connection-token` for a real embedded instance.

## GitHub Actions and app-bundle plan

The source contains GitHub workflows, but no `macos-15` workflow for this
server package. The official Darwin build path is Azure Pipelines on the
`AcesShared` macOS Sequoia image. A future GitHub `macos-15` reproduction is
plausible only after checking the runner's architecture and toolchain in the
job (`uname -m`, Xcode/clang, Python, Node 22.21.1). The job should run the
same `npm ci` environment and Gulp target, and should set a bounded timeout.
This spike did not claim a GitHub `macos-15` run.

If DevHub later ships an app, treat the generated directory as an embedded
server payload, for example:

```text
DevHub.app/
  Contents/Resources/openvscode-server/
    bin/openvscode-server
    node
    node_modules/**/*.node
    out/
    extensions/
```

The host should launch the bundled server as a child process with
`--host 127.0.0.1`, a stable persisted loopback port selected after the initial
setup, a mandatory token file in app support, and explicit server/user data
directories. The nested Node executable and
native `.node` files must be code-signed before signing/notarizing the outer
app. None of app bundling, signing, notarization, update delivery, or runtime
resource policy was implemented here.

For the detailed evidence, pass/fail matrix, and unresolved risks, see
[`PROTOTYPE-RESULTS.md`](PROTOTYPE-RESULTS.md).
