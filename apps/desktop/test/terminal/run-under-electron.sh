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

# VS Code's own Electron, not the DevHub-branded clone dev.sh boots. The clone
# exists so that macOS has a name to show for a running application; this one
# is an interpreter with no windows, so it has nothing to be named, and reading
# the unbranded bundle keeps the tests independent of the branding step.
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

# This run owns its tmux socket directory. tmux never unlinks a socket file —
# not when the server is killed, and not when it exits through `kill-server`
# either — and `tmux -L <name>` puts it in the shared /tmp/tmux-<uid>/ beside
# the developer's own live sockets, where nothing can safely sweep it up.
# TMUX_TMPDIR moves every socket these tests create into one directory that goes
# away with the run, which is also what makes it safe for a test to delete its
# own socket. The vitest side does the same thing in test/tmuxSockets.ts.
TMUX_TMPDIR="$REPO_ROOT/.spike/tmux-pty-$$"
export TMUX_TMPDIR
rm -rf "$TMUX_TMPDIR"
mkdir -p "$TMUX_TMPDIR"
trap 'rm -rf "$TMUX_TMPDIR"' EXIT

# Not `exec`: the socket directory has to be read for leaks and removed after
# the tests, which a replaced process could not do.
status=0
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" \
	--test \
	"$TEST_DIR/pty-under-electron.mjs" || status=$?

# Deleting the directory would hide a leak as well as clean one up, so read it
# first. Anything still here is a server a test did not end.
SOCKET_DIR="$TMUX_TMPDIR/tmux-$(id -u)"
if [ -d "$SOCKET_DIR" ]; then
	for socket in "$SOCKET_DIR"/*; do
		[ -e "$socket" ] || continue
		echo "the PTY tests left a tmux socket behind: $(basename "$socket") — every test that starts a tmux server has to kill it" >&2
		for candidate in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux; do
			[ -x "$candidate" ] || continue
			"$candidate" -L "$(basename "$socket")" kill-server >/dev/null 2>&1 || true
			break
		done
		status=1
	done
fi

exit "$status"
