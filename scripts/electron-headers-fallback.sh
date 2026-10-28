#!/usr/bin/env bash
# Make node-gyp's Electron headers available when electronjs.org is not.
#
# `npm ci` in vscode/ builds every native module from source against the
# Electron in vscode/.npmrc (`disturl=https://electronjs.org/headers`,
# `target=<electron>`). node-gyp downloads those headers once into its devdir
# (~/.cache/node-gyp/<target>) and reuses them afterwards. Some sandboxes —
# the agent containers DevHub is developed in among them — cannot reach
# electronjs.org at all, so the install dies in the first native module.
#
# Electron's headers are Node's headers for the Node that Electron embeds, with
# Electron's module ABI. Every native module in vscode/ is a Node-API module
# (node-addon-api), whose binary interface does not depend on V8's, so the
# matching Node release's headers from nodejs.org build working modules. This
# script puts exactly that into the devdir — only when the real headers cannot
# be downloaded and none are cached; it never replaces real ones.
#
# Used by scripts/test-local.sh before provisioning. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPMRC="$REPO_ROOT/vscode/.npmrc"
TARGET="$(sed -n 's/^target="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$NPMRC")"
DISTURL="$(sed -n 's/^disturl="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$NPMRC")"
[ -n "$TARGET" ] || { echo "no target= in $NPMRC" >&2; exit 1; }

DEVDIR="${npm_config_devdir:-${XDG_CACHE_HOME:-$HOME/.cache}/node-gyp}"
HEADERS="$DEVDIR/$TARGET"
if [ -f "$HEADERS/installVersion" ] && [ -f "$HEADERS/include/node/node_api.h" ]; then
	echo "Electron $TARGET headers: cached in $HEADERS"
	exit 0
fi
if curl -fsSIL --max-time 20 "$DISTURL/v$TARGET/node-v$TARGET-headers.tar.gz" >/dev/null 2>&1; then
	echo "Electron $TARGET headers: $DISTURL is reachable; node-gyp downloads them itself"
	exit 0
fi

# Which Node this Electron embeds, from Electron's own DEPS at its tag.
NODE_VERSION="$(curl -fsSL "https://raw.githubusercontent.com/electron/electron/v$TARGET/DEPS" \
	| awk "/'node_version':/ { getline; gsub(/[ ',v]/, \"\"); print; exit }")"
ABI="$(curl -fsSL "https://raw.githubusercontent.com/electron/electron/v$TARGET/build/args/all.gn" \
	| sed -n 's/^node_module_version = \([0-9]*\)$/\1/p')"
[ -n "$NODE_VERSION" ] && [ -n "$ABI" ] || { echo "could not read Electron $TARGET's Node version from GitHub" >&2; exit 1; }

echo "Electron $TARGET headers: $DISTURL is unreachable; using Node $NODE_VERSION's headers (Electron's embedded Node) with module ABI $ABI"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/headers.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-headers.tar.gz"
tar -xzf "$WORK/headers.tar.gz" -C "$WORK"
rm -rf "$HEADERS"
mkdir -p "$HEADERS"
mv "$WORK/node-v$NODE_VERSION/include" "$HEADERS/include"
sed -i.bak "s/\"node_module_version\": [0-9]*/\"node_module_version\": $ABI/" "$HEADERS/include/node/config.gypi"
rm -f "$HEADERS/include/node/config.gypi.bak"
# node-gyp's own marker for a complete header install (lib/install.js).
echo 11 > "$HEADERS/installVersion"
echo "installed into $HEADERS"
