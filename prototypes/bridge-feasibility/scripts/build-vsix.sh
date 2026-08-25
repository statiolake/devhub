#!/bin/zsh
# THROWAWAY F0.4 build: a VSIX is only a zip with a package.json at its root.
set -euo pipefail
root="${0:A:h:h}"
mkdir -p "$root/build"
vsix="$root/build/devhub-bridge-feasibility-0.0.1.vsix"
rm -f "$vsix"
(cd "$root" && /usr/bin/zip -q -r "$vsix" extension/package.json extension/extension.js)
/usr/bin/unzip -l "$vsix"
