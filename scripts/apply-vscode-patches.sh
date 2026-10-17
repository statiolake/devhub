#!/usr/bin/env bash
# Put DevHub's changes onto the VS Code submodule checkout: the overlay,
# patches/vscode-overlay/, and then patches/vscode/*.patch.
#
# VS Code is consumed, never edited: everything DevHub needs is a subclass, a
# service registration, or a replaced Electron static. patches/vscode/ is the
# one exception, for what none of those can reach. Each patch says why in its
# own body.
#
# The two halves hold different things, and the rule between them is strict:
#
#   patches/vscode/*.patch     changes to files upstream has — the hooks DevHub
#                              cannot reach any other way. Nothing else.
#   patches/vscode-overlay/    files upstream does not have, at the path they
#                              take in the tree (patches/vscode-overlay/src/vs/…
#                              is vscode/src/vs/…), copied in as they are: the
#                              Vim engine, the status bar hover, their tests.
#
# Whole new files kept as files rather than as `+` lines of a patch can be
# read, diffed and reviewed as source, and a VS Code bump can never fail on
# them. Each rule is checked before anything is touched: an overlay file that
# upstream has too (a bump added one by the same name), or a patch that
# reaches into an overlay file, stops the run with the path named, because the
# tree it would make depends on which half went first.
#
# Every patch is tried even when an earlier one did not apply (`git apply`
# applies a patch whole or not at all, and no two patches touch the same file),
# so a bump learns every patch it broke in one run, not one per run. The run
# still fails, naming each.
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
PATCHES_DIR="$REPO_ROOT/patches/vscode"
OVERLAY_DIR="$REPO_ROOT/patches/vscode-overlay"
usage() { echo "usage: $(basename "$0") [--into DIR]" >&2; exit 2; }

INTO=""
if [ $# -gt 0 ]; then
	[ "$1" = "--into" ] && [ $# -eq 2 ] || usage
	INTO="$2"
fi
TREE="${INTO:-$VSCODE_DIR}"

# The overlay's files, relative to it, one per line, in byte order.
overlay_files() {
	[ -d "$OVERLAY_DIR" ] || return 0
	(cd "$OVERLAY_DIR" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
}

# Every path a patch names, old side and new.
patched_paths() {
	local patch
	for patch in "$PATCHES_DIR"/*.patch; do
		[ -e "$patch" ] || continue
		sed -n -e 's|^+++ b/||p' -e 's|^--- a/||p' "$patch"
	done | LC_ALL=C sort -u
}

# The two halves must not overlap, and the overlay must add only: checked
# against the pinned commit before anything is touched.
check_layout() {
	local problems="" f patched
	patched="$(patched_paths)"
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		if printf '%s\n' "$patched" | grep -qxF -- "$f"; then
			problems="$problems
  $f: in patches/vscode-overlay/ and changed by a patch in patches/vscode/"
		fi
		if git -C "$TREE" cat-file -e "HEAD:$f" 2>/dev/null; then
			problems="$problems
  $f: in patches/vscode-overlay/, but upstream has this file too; a change to it
    belongs in a patch, a file of DevHub's own needs a name upstream does not use"
		fi
	done <<EOF
$(overlay_files)
EOF
	if [ -n "$problems" ]; then
		echo "apply-vscode-patches.sh: the overlay and the patches disagree:$problems" >&2
		exit 1
	fi
}

copy_overlay() {
	local f n=0
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		if [ -e "$TREE/$f" ]; then
			echo "apply-vscode-patches.sh: $f is already in the tree; reset it first" >&2
			exit 1
		fi
		mkdir -p "$(dirname "$TREE/$f")"
		cp "$OVERLAY_DIR/$f" "$TREE/$f"
		n=$((n + 1))
	done <<EOF
$(overlay_files)
EOF
	echo "copied patches/vscode-overlay/ ($n files)"
}

# Whatever `after_each` is set to runs after the overlay and after every patch
# that applied.
after_each() { :; }

apply_all() {
	local patch failed="" total=0
	check_layout
	copy_overlay
	after_each
	for patch in "$PATCHES_DIR"/*.patch; do
		[ -e "$patch" ] || continue
		total=$((total + 1))
		echo "applying $(basename "$patch")"
		if git -C "$TREE" apply "$patch"; then
			after_each
		else
			failed="$failed $(basename "$patch")"
		fi
	done
	if [ -n "$failed" ]; then
		set -- $failed
		echo "apply-vscode-patches.sh: $# of $total patches did not apply:" >&2
		for patch in "$@"; do echo "  $patch" >&2; done
		exit 1
	fi
}

if [ -n "$INTO" ]; then
	apply_all
	exit 0
fi

# The reset refuses, naming the files, when the tree holds edits that are not
# the changes a previous run made (scripts/vscode-submodule.sh). After the
# overlay and after each patch the tree is recorded as DevHub's own, so a run
# that stops halfway still leaves a tree the next run may reset.
"$REPO_ROOT/scripts/vscode-submodule.sh" reset
after_each() { "$REPO_ROOT/scripts/vscode-submodule.sh" record; }
apply_all
