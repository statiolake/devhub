#!/usr/bin/env bash
# Run DevHub from this checkout: `pnpm dev`.
#
# The main process runs in DevHub's own Electron, npm's `electron` at the
# version apps/desktop/package.json pins (scripts/electron-path.sh). On a Mac
# it runs inside a DevHub-branded clone of that bundle, because macOS names an
# application from the bundle it runs in: booting npm's own would put
# "Electron" in the menu bar, the Dock and the window switcher no matter what
# the process calls itself (scripts/darwin_bundle.py).
#
# Any argument is passed through to the app.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

ELECTRON="$("$APP_DIR/scripts/electron-path.sh")"
if [ "$(uname -s)" = Darwin ]; then
	BRANDED="$REPO_ROOT/dist/dev-electron"
	python3 "$REPO_ROOT/scripts/darwin_bundle.py" "$BRANDED" >/dev/null
	ELECTRON="$BRANDED/DevHub.app/Contents/MacOS/DevHub"
fi
if [ ! -x "$ELECTRON" ]; then
	echo "no Electron at $ELECTRON — run 'pnpm install'" >&2
	exit 1
fi

if [ ! -f "$APP_DIR/out/main/main.js" ] || [ ! -f "$APP_DIR/dist/shell/index.html" ]; then
	echo "apps/desktop is not built — run 'pnpm --filter @devhub/desktop build'" >&2
	exit 1
fi

# Which DevHub this run is. A source run is a *second* DevHub: the packaged one
# is the environment the person works in, and the two cannot share the
# user-data directory (Electron's single-instance lock is in it), the
# settings, the tmux server or the control socket. `DEVHUB_PROFILE` is the
# whole switch — set it to `default` to run a source build on the packaged
# app's own locations instead.
export DEVHUB_PROFILE="${DEVHUB_PROFILE:-dev}"

# Every location the profile decides, derived where it is decided — in
# src/model/profile.ts, printed by out/main/profilePaths.js.
eval "$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$APP_DIR/out/main/profilePaths.js")"
mkdir -p "$DEVHUB_USER_DATA_DIR"
echo "[devhub] profile $DEVHUB_PROFILE_NAME: user data $DEVHUB_USER_DATA_DIR, settings $DEVHUB_CONFIG_DIR, tmux socket $DEVHUB_TMUX_SOCKET_NAME" >&2

export NODE_ENV=development
export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_ENABLE_STACK_DUMPING=1

exec "$ELECTRON" "$APP_DIR" --user-data-dir "$DEVHUB_USER_DATA_DIR" "$@"
