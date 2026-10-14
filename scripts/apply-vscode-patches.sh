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
# It lives in its own script because three callers need exactly this and
# nothing else around it: scripts/provision-vscode.sh on the way to a compile,
# the VS Code bump workflow, which wants to know whether the patches still
# apply to a newer upstream tag without paying for the compile to find out, and
# the Linux build of the remote servers (scripts/build_reh.py ->
# scripts/reh_in_container.sh), which applies them to a copy of the pinned
# commit of its own inside a container.
#
#   apply-vscode-patches.sh               onto the submodule, vscode/
#   apply-vscode-patches.sh --into DIR    onto DIR, a git repository holding a
#                                         pristine copy of the pinned commit
#                                         whose working tree the caller has
#                                         already reset. vscode/ is not touched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
usage() { echo "usage: $(basename "$0") [--into DIR]" >&2; exit 2; }

INTO=""
if [ $# -gt 0 ]; then
	[ "$1" = "--into" ] && [ $# -eq 2 ] || usage
	INTO="$2"
fi

if [ -n "$INTO" ]; then
	for patch in "$REPO_ROOT"/patches/vscode/*.patch; do
		[ -e "$patch" ] || continue
		echo "applying $(basename "$patch")"
		git -C "$INTO" apply "$patch"
	done
	exit 0
fi

# The reset refuses, naming the files, when the tree holds edits that are not
# the patches a previous run applied (scripts/vscode-submodule.sh). After each
# patch the tree is recorded as DevHub's own, so a run that stops halfway still
# leaves a tree the next run may reset.
"$REPO_ROOT/scripts/vscode-submodule.sh" reset
for patch in "$REPO_ROOT"/patches/vscode/*.patch; do
	[ -e "$patch" ] || continue
	echo "applying $(basename "$patch")"
	git -C "$VSCODE_DIR" apply "$patch"
	"$REPO_ROOT/scripts/vscode-submodule.sh" record
done
