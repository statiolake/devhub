#!/bin/zsh
# THROWAWAY F0.2: package the local public-API fixture without dependencies.
set -euo pipefail

root="${0:A:h:h}"
mkdir -p "$root/build"
vsix="$root/build/devhub-real-workbench-fixture-0.0.1.vsix"
rm -f "$vsix"
staging="$(mktemp -d /private/tmp/devhub-real-fixture-vsix.XXXXXX)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/extension"
cp "$root/fixture-extension/package.json" "$staging/extension/package.json"
cp "$root/fixture-extension/extension.js" "$staging/extension/extension.js"
(cd "$staging" && /usr/bin/zip -q -r "$vsix" extension/package.json extension/extension.js)
/usr/bin/unzip -l "$vsix"
