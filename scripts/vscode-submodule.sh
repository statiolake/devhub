#!/usr/bin/env bash
# Keep the VS Code submodule's checkout equal to the commit the superproject
# pins plus DevHub's patches and overlay.
#
# vscode/ is not edited by hand: every build resets it to pinned + patches +
# overlay, whatever it holds, and keeps a backup ref of what it replaced.
#
#   scripts/vscode-submodule.sh sync          put vscode/ on the pinned commit
#   scripts/vscode-submodule.sh reset         take everything off vscode/ that
#                                             is not the pinned commit
#   scripts/vscode-submodule.sh is-applied    exit 0 when vscode/ already is the
#                                             pinned commit + the current
#                                             patches + overlay (nothing to do)
#   scripts/vscode-submodule.sh export        write vscode/'s DevHub changes back
#                                             into patches/vscode/ and
#                                             patches/vscode-overlay/
#   scripts/vscode-submodule.sh source-state  the hash of what the tree is built
#                                             from (the commit, the patches,
#                                             the overlay), for the stamps
#
# Why `sync` exists: `git pull` moves the superproject's gitlink but leaves the
# submodule where it was, and provisioning used to check only that vscode/ was
# checked out at all. After the 1.141.0 bump that meant patches refreshed for
# 1.141.0 were applied onto a 1.136.1 tree and failed with `patch failed`, a
# message naming neither the bump nor the fix. The pinned commit is read from
# the superproject's *index*, not HEAD, because scripts/vscode-bump-apply.sh
# stages a bump (`git add vscode`) before it provisions against it.
#
# Why `reset` never refuses: nobody edits vscode/ by hand, and its working tree
# is expected to differ from the pinned commit anyway (patches/vscode and
# patches/vscode-overlay are applied onto it, hence `ignore = dirty` in
# .gitmodules; the build also leaves files of its own, e.g. the
# devhub-init/types/vscode.d.ts copy). So a reset needs no verdict on whose
# changes they are: it resets (`reset --hard`, `clean -fd`, never `-x`, so
# ignored node_modules, out*, .build stay) and keeps the tree it replaced as a
# commit on refs/devhub/vscode-before-reset (with a reflog) in vscode/, so
# nothing a reset took is gone for good:
# `git -C vscode log -g refs/devhub/vscode-before-reset`.
#
# Why `export` stays: for whoever does edit vscode/ (where it compiles and its
# tests run), the edit has to go back to where it is kept — but a build discards
# whatever was not exported first (the backup ref is the only copy). `export`
# splits the tree's changes the way scripts/apply-vscode-patches.sh joins
# them — a change to a file upstream has goes into the one patch that changes
# that file, a file upstream does not have goes into the overlay — and refuses,
# changing nothing and naming each path, whenever that is not a mechanical
# decision: see scripts/vscode_export.py.
set -euo pipefail

REPO_ROOT="${DEVHUB_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VSCODE_DIR="$REPO_ROOT/vscode"
PATCHES_DIR="$REPO_ROOT/patches/vscode"
OVERLAY_DIR="$REPO_ROOT/patches/vscode-overlay"

die() { printf 'vscode-submodule.sh: %s\n' "$1" >&2; exit 1; }

vscode_version() {
	sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$VSCODE_DIR/package.json" 2>/dev/null | head -1
}

# Tracked files VS Code's own build rewrites while DevHub drives it. They are
# left out of the comparison with "pinned + patches + overlay", so a build's
# rewrite alone does not make the tree look changed (and is not backed up);
# `reset` and `is-applied` still put them back.
#   extensions/copilot/package.json
#     scripts/build_reh.py runs `gulp compile-copilot-extension-build`, which,
#     with `CI` in the environment ("Running in CI environment, applying
#     package.json patch for correct versioning and pre-release status"),
#     rewrites the extension's version/pre-release fields. DevHub scripts do
#     not set CI; it comes from the runner or the developer's shell, and
#     build_reh.py passes VSCODE_QUALITY=stable so the version stays the
#     pinned one. The file is rewritten all the same.
BUILD_WRITTEN=(
	extensions/copilot/package.json
)

# The overlay's files, relative to it, one per line, in byte order.
overlay_files() {
	[ -d "$OVERLAY_DIR" ] || return 0
	(cd "$OVERLAY_DIR" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
}

# What a compiled tree is built from: the submodule commit, every patch, and
# every overlay file by path and contents. provision-vscode.sh stamps out/ and
# out-vscode-min/ with it, and apps/desktop/scripts/dev.sh and
# scripts/package-nightly.py compare those stamps against it, all through this
# one definition.
cmd_source_state() {
	local f
	{
		git -C "$VSCODE_DIR" rev-parse HEAD
		cat "$PATCHES_DIR"/*.patch 2>/dev/null || true
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			printf 'overlay %s\n' "$f"
			cat "$OVERLAY_DIR/$f"
		done <<EOF
$(overlay_files)
EOF
	} | shasum | cut -d' ' -f1
}

# The tree's changes back into patches/vscode/ and patches/vscode-overlay/.
cmd_export() {
	python3 "$REPO_ROOT/scripts/vscode_export.py" "$REPO_ROOT" ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}
}

# vscode_state.py, with the build-written paths left out of the comparison.
state() {
	local args=(--root "$REPO_ROOT") f
	for f in ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}; do
		args+=(--exclude "$f")
	done
	python3 "$REPO_ROOT/scripts/vscode_state.py" "${args[@]}" "$@"
}

# Take the tree back to its commit, whatever it holds. A changed tree is first
# kept as a commit on refs/devhub/vscode-before-reset; ignored files —
# node_modules, out*, .build, the build caches — are never touched: no
# `git clean -x`.
cmd_reset() {
	local verdict files backup count
	verdict="$(state classify)" || die "could not read vscode/'s state"
	files="$(printf '%s\n' "$verdict" | sed 1d)"
	verdict="$(printf '%s\n' "$verdict" | head -1)"
	case "$verdict" in
		clean) ;;
		current) state backup "reset" >/dev/null ;;
		dirty)
			backup="$(state backup "reset")"
			count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
			echo "vscode/: resetting $count changed file(s) to the pinned commit (backup: git -C vscode show --stat ${backup:0:12})"
			;;
		*) die "unexpected state '$verdict'" ;;
	esac
	if [ -n "$(git -C "$VSCODE_DIR" status --porcelain --untracked-files=all)" ]; then
		git -C "$VSCODE_DIR" reset -q --hard HEAD
		git -C "$VSCODE_DIR" clean -fdq
	fi
	[ -z "$(git -C "$VSCODE_DIR" status --porcelain)" ] || die "vscode/ is still not clean after the reset"
}

# Exit 0 when vscode/ is the pinned commit with exactly the current patches and
# overlay on it — nothing to apply — and 1 otherwise. A build-written file is
# put back the way a reset would have.
cmd_is_applied() {
	local pinned f
	pinned="$(pinned_commit)"
	[ -f "$VSCODE_DIR/package.json" ] || return 1
	[ "$(git -C "$VSCODE_DIR" rev-parse HEAD)" = "$pinned" ] || return 1
	[ "$(state classify | head -1)" = current ] || return 1
	for f in ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}; do
		[ -n "$f" ] || continue
		if git -C "$VSCODE_DIR" cat-file -e "HEAD:$f" 2>/dev/null \
			&& ! git -C "$VSCODE_DIR" diff --quiet HEAD -- "$f"; then
			git -C "$VSCODE_DIR" checkout -q HEAD -- "$f"
		fi
	done
}

pinned_commit() {
	git -C "$REPO_ROOT" ls-files -s -- vscode | awk '{print $2}'
}

cmd_sync() {
	local pinned current old_version
	pinned="$(pinned_commit)"
	[ -n "$pinned" ] || die "the superproject does not record a vscode submodule commit"

	if [ ! -f "$VSCODE_DIR/package.json" ]; then
		git -C "$REPO_ROOT" submodule update --init --depth 1 -- vscode
		echo "checked out: $(git -C "$VSCODE_DIR" rev-parse --short HEAD) (VS Code $(vscode_version))"
		return
	fi

	current="$(git -C "$VSCODE_DIR" rev-parse HEAD)"
	if [ "$current" = "$pinned" ]; then
		echo "checked out: $(git -C "$VSCODE_DIR" rev-parse --short HEAD) (VS Code $(vscode_version))"
		return
	fi

	old_version="$(vscode_version)"
	cmd_reset
	# .gitmodules says `shallow = true`; --depth 1 fetches just the pinned
	# commit when the shallow clone does not have it yet.
	git -C "$REPO_ROOT" submodule update --init --checkout --depth 1 -- vscode
	[ "$(git -C "$VSCODE_DIR" rev-parse HEAD)" = "$pinned" ] \
		|| die "vscode/ did not move to the pinned commit $pinned"
	echo "updated vscode: ${current:0:11} (VS Code $old_version) → ${pinned:0:11} (VS Code $(vscode_version))"
}

USAGE="usage: $(basename "$0") sync|reset|is-applied|export|source-state"
[ $# -eq 1 ] || { echo "$USAGE" >&2; exit 2; }
case "$1" in
	sync) cmd_sync ;;
	reset) cmd_reset ;;
	is-applied) cmd_is_applied ;;
	export) cmd_export ;;
	source-state) cmd_source_state ;;
	*) echo "$USAGE" >&2; exit 2 ;;
esac
