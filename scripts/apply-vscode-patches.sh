#!/usr/bin/env bash
# Put patches/vscode/*.patch onto the VS Code submodule checkout.
#
# VS Code is consumed, never edited: everything DevHub needs is a subclass, a
# service registration, or a replaced Electron static. patches/vscode/ is the
# one exception, for what none of those can reach. Each patch says why in its
# own body.
#
# The working tree is reset first, so running this twice is the same as running
# it once. That reset is also why .gitmodules marks the submodule `ignore =
# dirty`: the checkout is expected to differ from the pinned commit.
#
# It lives in its own script because two callers need exactly this and nothing
# else around it: scripts/provision-vscode.sh on the way to a compile, and the
# VS Code bump workflow, which wants to know whether the patches still apply to
# a newer upstream tag without paying for the compile to find out.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"

git -C "$VSCODE_DIR" checkout -- .
for patch in "$REPO_ROOT"/patches/vscode/*.patch; do
	[ -e "$patch" ] || continue
	echo "applying $(basename "$patch")"
	git -C "$VSCODE_DIR" apply "$patch"
done
