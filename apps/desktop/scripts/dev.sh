#!/usr/bin/env bash
# Run DevHub against the pinned VS Code submodule.
#
# The main process runs inside VS Code's own Electron: the native modules in
# vscode/node_modules are built for exactly that binary, and nothing else will
# load them. The environment below is the same one vscode/scripts/code.sh sets
# for a source build, plus DevHub's own editor and extensions directories.
#
# Any argument is passed through to the app, so a second invocation such as
#   apps/desktop/scripts/dev.sh --new-window <folder>
# reaches the already-running instance the way `code` does.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

# The binary is named after VS Code's own product, because it is VS Code's own
# Electron: the app bundle npm run electron unpacked into the submodule.
case "$(uname -s)" in
	Darwin) ELECTRON="$VSCODE_DIR/.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS" ;;
	*) ELECTRON="$VSCODE_DIR/.build/electron/code-oss" ;;
esac
if [ ! -x "$ELECTRON" ]; then
	echo "no Electron at $ELECTRON — run scripts/provision-vscode.sh" >&2
	exit 1
fi

if [ ! -f "$APP_DIR/out/main/main.js" ] || [ ! -f "$APP_DIR/dist/shell/index.html" ]; then
	echo "apps/desktop is not built — run 'pnpm --filter @devhub/desktop build'" >&2
	exit 1
fi

# The built-in set is staged on every run: it is only symlinks, and a stale one
# would silently run yesterday's bridge — including yesterday's workbench
# defaults.
"$REPO_ROOT/scripts/stage-builtin-extensions.sh" >/dev/null

# DevHub's product identity and its extension gallery, from the one file that
# holds them (scripts/package-nightly.py writes the packaged product.json from
# the same file). A source run reads vscode/product.json, so the overrides have
# to reach it another way: vscode/src/bootstrap-meta.ts merges
# vscode/product.overrides.json over it whenever VSCODE_DEV is set, in every
# process that boots VS Code's ESM loader — main, renderer, shared process,
# extension host — which is exactly the reach the gallery needs. The file is
# gitignored inside the submodule and rewritten here on every run, so the
# submodule stays unedited and can never hold a stale copy.
cp "$APP_DIR/product-overrides.json" "$VSCODE_DIR/product.overrides.json"

# DevHub's own state, beside the user's real VS Code state and never inside it.
DEVHUB_DATA="$HOME/Library/Application Support/DevHub"
USER_DATA_DIR="$DEVHUB_DATA/editor"
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
	--builtin-extensions-dir "$REPO_ROOT/vscode/.build/devhub-builtin-extensions" \
	--disable-extension=vscode.vscode-api-tests \
	"$@"
