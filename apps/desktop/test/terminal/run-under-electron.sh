#!/usr/bin/env bash
# The terminal tests that need the native node-pty.
#
# node-pty lives in the VS Code submodule and is built for VS Code's own
# Electron, so the only interpreter that can load it is that binary run as Node
# (ELECTRON_RUN_AS_NODE=1). The modules under test are compiled first, because
# that interpreter runs JavaScript, not TypeScript.
#
# Everything else about the terminal is pure logic and runs under vitest.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$TEST_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

case "$(uname -s)" in
	Darwin) ELECTRON="$VSCODE_DIR/.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS" ;;
	*) ELECTRON="$VSCODE_DIR/.build/electron/code-oss" ;;
esac
if [ ! -x "$ELECTRON" ]; then
	echo "no Electron at $ELECTRON — run scripts/provision-vscode.sh" >&2
	exit 1
fi
if [ ! -f "$VSCODE_DIR/node_modules/node-pty/build/Release/pty.node" ]; then
	echo "the submodule has no built node-pty — run scripts/provision-vscode.sh" >&2
	exit 1
fi

"$APP_DIR/node_modules/.bin/tsc" -p "$TEST_DIR/tsconfig.json"

# Scratch directories the tests create live under .spike/, never in $TMPDIR.
mkdir -p "$REPO_ROOT/.spike"

ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" \
	--test \
	"$TEST_DIR/pty-under-electron.mjs"
