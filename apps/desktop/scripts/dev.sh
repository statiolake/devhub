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

# VS Code's own Electron, because the native modules in vscode/node_modules are
# built for exactly that binary. On a Mac it is the branded clone provisioning
# makes rather than the bundle `npm run electron` unpacked: macOS names an
# application from the bundle it runs in, so booting VS Code's own would put
# "Code - OSS" in the menu bar, the Dock and the window switcher no matter what
# the process calls itself. See step 5b of scripts/provision-vscode.sh.
case "$(uname -s)" in
	Darwin) ELECTRON="$VSCODE_DIR/.build/devhub-electron/DevHub.app/Contents/MacOS/DevHub" ;;
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
# The commit rides along with the names, so a source run can say which DevHub
# it is too — see scripts/product_metadata.py, which the packaged build writes
# its product.json from as well.
"$REPO_ROOT/scripts/product_metadata.py" "$VSCODE_DIR/product.overrides.json"

# Which DevHub this run is. A source run is a *second* DevHub: the packaged one
# is the environment the person works in, and the two cannot share the editor's
# user-data directory (VS Code makes that single-instance, so the second one
# simply never starts), the settings, the tmux server or the control socket.
# `DEVHUB_PROFILE` is the whole switch — set it to `default` to run a source
# build on the packaged app's own locations instead.
export DEVHUB_PROFILE="${DEVHUB_PROFILE:-dev}"

# Every location the profile decides, derived where it is decided — in
# src/model/profile.ts, printed by out/main/profilePaths.js. Spelling them here
# as well is how the shell and the app end up disagreeing after a rename.
eval "$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$APP_DIR/out/main/profilePaths.js")"
mkdir -p "$DEVHUB_USER_DATA_DIR" "$DEVHUB_EXTENSIONS_DIR"
echo "[devhub] profile $DEVHUB_PROFILE_NAME: user data $DEVHUB_USER_DATA_DIR, settings $DEVHUB_CONFIG_DIR, tmux socket $DEVHUB_TMUX_SOCKET_NAME" >&2

export VSCODE_DEV=1
export VSCODE_CLI=1
export NODE_ENV=development
export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_ENABLE_STACK_DUMPING=1

exec "$ELECTRON" "$APP_DIR" \
	--user-data-dir "$DEVHUB_USER_DATA_DIR" \
	--extensions-dir "$DEVHUB_EXTENSIONS_DIR" \
	--builtin-extensions-dir "$REPO_ROOT/vscode/.build/devhub-builtin-extensions" \
	--disable-extension=vscode.vscode-api-tests \
	"$@"
