#!/bin/zsh
# Build the finite diagnostic extension without npm dependencies.
set -euo pipefail

root="${0:A:h:h}"
output="$root/build/devhub-real-workbench-native-input-0.0.1.vsix"
mkdir -p "$root/build"
rm -f "$output"
(
  cd "$root"
  /usr/bin/zip -q -r "$output" extension/package.json extension/extension.js
)
/usr/bin/unzip -tq "$output"
print "built $output"
