#!/usr/bin/env bash
# The Electron DevHub runs on, printed as a path: `electron` from npm, the
# exact version apps/desktop/package.json pins. Its binary is downloaded the
# first time it is asked for (the package has no install script any more), so
# everything that starts DevHub's Electron — dev.sh, the PTY tests, the smoke
# test, packaging — asks here rather than spelling the path.
#
# On macOS the path is `.../Electron.app/Contents/MacOS/Electron`; the bundle
# is three directories up.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
# The first call downloads when the binary is missing, and says so on stdout;
# that goes to stderr here so that stdout is the path and nothing else.
node -e 'require("electron")' </dev/null >&2
node -e 'process.stdout.write(require("electron"))' </dev/null
