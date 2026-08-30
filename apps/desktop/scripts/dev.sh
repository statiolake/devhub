#!/usr/bin/env bash
# Run DevHub against the pinned VS Code submodule.
#
# The main process runs inside VS Code's own Electron: the native modules in
# vscode/node_modules are built for exactly that binary, and nothing else will
# load them. The environment below is the same one vscode/scripts/code.sh sets
# for a source build, plus DevHub's own user-data and extensions directories.
#
# Any argument is passed through to the app, so a second invocation such as
#   apps/desktop/scripts/dev.sh --new-window <folder>
# reaches the already-running instance the way `code` does.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

ELECTRON="$VSCODE_DIR/.build/electron/Code - OSS.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ]; then
	ELECTRON="$VSCODE_DIR/.build/electron/electron"
fi
if [ ! -x "$ELECTRON" ]; then
	echo "no Electron in $VSCODE_DIR/.build — run scripts/provision-vscode.sh" >&2
	exit 1
fi

if [ ! -f "$APP_DIR/out/main/main.js" ] || [ ! -f "$APP_DIR/dist/shell/index.html" ]; then
	echo "apps/desktop is not built — run 'pnpm --filter @devhub/desktop build'" >&2
	exit 1
fi

# DevHub's own state, beside the user's real VS Code state and never inside it.
DEVHUB_DATA="$HOME/Library/Application Support/DevHub"
USER_DATA_DIR="$DEVHUB_DATA/user-data"
EXTENSIONS_DIR="$DEVHUB_DATA/extensions"
mkdir -p "$USER_DATA_DIR" "$EXTENSIONS_DIR"

export VSCODE_DEV=1
export VSCODE_CLI=1
export NODE_ENV=development
export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_ENABLE_STACK_DUMPING=1

exec "$ELECTRON" "$APP_DIR" \
	--user-data-dir "$USER_DATA_DIR" \
	--extensions-dir "$EXTENSIONS_DIR" \
	--disable-extension=vscode.vscode-api-tests \
	"$@"
