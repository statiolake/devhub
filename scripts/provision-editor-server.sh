#!/usr/bin/env bash
# Stage the VS Code Server the Editor runs against.
#
# DevHub ships a VSCodium build rather than downloading one at first launch.
# VSCodium is not a fork — it is Microsoft's own `vscode` sources built without
# the proprietary product configuration, which makes the result MIT, free of
# telemetry, and pointed at Open VSX. That is exactly the server DevHub wants,
# already de-Microsoft'd, so there is nothing to build here: the release is
# fetched and verified.
#
# The version is pinned on both sides. monaco-vscode-api supplies the Workbench
# and names the VS Code release it was generated from; the server has to be the
# same release, because the two speak a protocol that is only promised to match
# within one. Both projects skip releases, and 1.121 is where their two sets of
# builds currently meet — see docs in scripts/README or the commit that added
# this file. Change VSCODE_RELEASE and VSCODIUM_RELEASE together, or not at all.
set -euo pipefail

VSCODE_RELEASE="1.121.0"       # what monaco-vscode-api v33.x was generated from
VSCODE_COMMIT="987c9597516278c9fcf10d963a0592ce1384ab93" # ...and at which commit
VSCODIUM_RELEASE="1.121.03429" # the VSCodium build of that release

# Recorded here rather than fetched alongside the archive: a checksum that
# travels with the download proves only that the download was not corrupted.
# macOS ships bash 3.2, which has no associative arrays.
sha256_for() {
  case "$1" in
    darwin-arm64) echo "d0806e9a61ff4c9a658fdea790da6afd937499e1488e86252281a288e713188d" ;;
    darwin-x64) echo "2b21ce107f2dec54583c53b5f71182ee73508910f104e2872d14d52897ab870d" ;;
    *) return 1 ;;
  esac
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINATION="$ROOT/apps/devhub/src-tauri/resources/editor-server"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) PLATFORM="darwin-x64" ;;
  *) echo "DevHub is a macOS application; $(uname -s)/$(uname -m) has no server build here." >&2; exit 1 ;;
esac

ARCHIVE="vscodium-reh-web-$PLATFORM-$VSCODIUM_RELEASE.tar.gz"
URL="https://github.com/VSCodium/vscodium/releases/download/$VSCODIUM_RELEASE/$ARCHIVE"
STAMP="$DESTINATION/.provisioned"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VSCODIUM_RELEASE/$PLATFORM" ]; then
  echo "editor server $VSCODIUM_RELEASE ($PLATFORM) already staged"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching $ARCHIVE"
curl --fail --location --silent --show-error --output "$WORK/$ARCHIVE" "$URL"

echo "verifying"
ACTUAL="$(shasum -a 256 "$WORK/$ARCHIVE" | awk '{print $1}')"
EXPECTED="$(sha256_for "$PLATFORM")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "checksum mismatch for $ARCHIVE" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

echo "staging into ${DESTINATION#"$ROOT"/}"
rm -rf "$DESTINATION"
mkdir -p "$DESTINATION"
# The archive holds the server at its root, not under a version directory.
tar xzf "$WORK/$ARCHIVE" -C "$DESTINATION"

if [ ! -x "$DESTINATION/bin/codium-server" ] && [ ! -x "$DESTINATION/bin/code-server" ]; then
  echo "the archive did not contain a server entry point under bin/" >&2
  ls "$DESTINATION" >&2
  exit 1
fi

# The client refuses a server whose commit is not the one it was generated
# from. VSCodium records its own build commit, which is a different string for
# the same VS Code sources, so the identity is restated here. This is a
# handshake value, not a version: if the releases above ever stop naming the
# same VS Code, changing this would hide that rather than fix it.
python3 - "$DESTINATION/product.json" "$VSCODE_COMMIT" <<'PYTHON'
import json, sys

path, commit = sys.argv[1], sys.argv[2]
with open(path) as handle:
    product = json.load(handle)
product["commit"] = commit
with open(path, "w") as handle:
    json.dump(product, handle, indent=2)
PYTHON

printf '%s/%s' "$VSCODIUM_RELEASE" "$PLATFORM" > "$STAMP"
echo "editor server $VSCODIUM_RELEASE ($PLATFORM) staged for VS Code $VSCODE_RELEASE"
