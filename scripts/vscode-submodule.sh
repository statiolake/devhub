#!/usr/bin/env bash
# Keep the VS Code submodule's checkout in step with the commit the superproject
# pins, without ever throwing away an edit DevHub did not make.
#
#   scripts/vscode-submodule.sh sync          put vscode/ on the pinned commit
#   scripts/vscode-submodule.sh reset         take DevHub's changes back off
#   scripts/vscode-submodule.sh record        note the tree as "DevHub's own edits"
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
# Why `record`: the working tree is expected to differ from the pinned commit
# (patches/vscode and patches/vscode-overlay are applied onto it, hence
# `ignore = dirty` in .gitmodules), so "dirty" cannot tell DevHub's edits from
# a developer's. After the overlay and after every patch
# scripts/apply-vscode-patches.sh records a fingerprint of the tree's changes
# inside the submodule's git dir: every tracked change, and every untracked
# file *with its contents*, so an edit to an overlay file in vscode/ is a
# developer's edit like any other. A tree whose changes match it, or that has
# none, is DevHub's to reset; anything else stops with the files named. A
# fresh checkout (CI) has no changes, so none of this costs it anything.
#
# Why `export`: an edit made in vscode/ (where it compiles and its tests run)
# has to go back to where it is kept. `export` splits the tree's changes the
# way scripts/apply-vscode-patches.sh joins them — a change to a file upstream
# has goes into the one patch that changes that file, a file upstream does not
# have goes into the overlay — and refuses, changing nothing and naming each
# path, whenever that is not a mechanical decision: see scripts/vscode_export.py.
#
# DEVHUB_DISCARD_VSCODE_CHANGES=1 resets regardless, for when the edits really
# are disposable.
set -euo pipefail

REPO_ROOT="${DEVHUB_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VSCODE_DIR="$REPO_ROOT/vscode"
PATCHES_DIR="$REPO_ROOT/patches/vscode"
OVERLAY_DIR="$REPO_ROOT/patches/vscode-overlay"

die() { printf 'vscode-submodule.sh: %s\n' "$1" >&2; exit 1; }

vscode_version() {
	sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$VSCODE_DIR/package.json" 2>/dev/null | head -1
}

# The fingerprint's file inside the submodule's git dir. `devhub-patched-tree`
# is the first format's (untracked files by name only), still read once so a
# tree patched before the overlay existed can be reset; `record` writes `.v2`.
git_path() {
	local p
	p="$(git -C "$VSCODE_DIR" rev-parse --git-path "$1")"
	case "$p" in /*) ;; *) p="$VSCODE_DIR/$p" ;; esac
	printf '%s' "$p"
}
marker_path() { git_path devhub-patched-tree.v2; }
legacy_marker_path() { git_path devhub-patched-tree; }

# Tracked files VS Code's own build rewrites while DevHub drives it, so their
# changes are DevHub's pipeline output, not a developer's edit. They are left
# out of the fingerprint (recorded after patching, i.e. before any build) and
# out of the legacy patched-files check; `reset` still reverts them.
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

# Pathspec: the whole tree minus BUILD_WRITTEN. Fills the global PATHSPEC
# array (no mapfile: bash 3.2). Never contains an empty string.
PATHSPEC=()
build_pathspec() {
	local f
	PATHSPEC=(.)
	for f in ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}; do
		[ -n "$f" ] || continue
		PATHSPEC+=(":(exclude)$f")
	done
}

# Every tracked change (bar BUILD_WRITTEN) and every untracked, non-ignored
# file, by name and by the hash of its contents, hashed. Empty output means the
# tree is its HEAD, give or take those.
fingerprint() {
	local changes untracked
	build_pathspec
	untracked="$(git -C "$VSCODE_DIR" ls-files --others --exclude-standard)"
	changes="$(
		git -C "$VSCODE_DIR" diff --binary HEAD -- "${PATHSPEC[@]}"
		if [ -n "$untracked" ]; then
			printf '%s\n' "$untracked"
			printf '%s\n' "$untracked" | (cd "$VSCODE_DIR" && git hash-object --stdin-paths)
		fi
	)"
	[ -z "$changes" ] && return 0
	printf '%s' "$changes" | git hash-object --stdin
}

# The first format, which named untracked files without their contents.
legacy_fingerprint() {
	local changes
	build_pathspec
	changes="$(
		git -C "$VSCODE_DIR" diff --binary HEAD -- "${PATHSPEC[@]}"
		git -C "$VSCODE_DIR" ls-files --others --exclude-standard
	)"
	[ -z "$changes" ] && return 0
	printf '%s' "$changes" | git hash-object --stdin
}

# The overlay's files, relative to it, one per line, in byte order.
overlay_files() {
	[ -d "$OVERLAY_DIR" ] || return 0
	(cd "$OVERLAY_DIR" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
}

# Whether every change in the tree is one DevHub makes: a file a patch
# modifies, or an untracked file that is an overlay file byte for byte.
only_patched_files_changed() {
	local changed patched f
	build_pathspec
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		[ -f "$OVERLAY_DIR/$f" ] && cmp -s "$OVERLAY_DIR/$f" "$VSCODE_DIR/$f" || return 1
	done <<EOF
$(git -C "$VSCODE_DIR" ls-files --others --exclude-standard)
EOF
	changed="$(git -C "$VSCODE_DIR" diff --name-only HEAD -- "${PATHSPEC[@]}" | sort -u)"
	patched="$(cat "$PATCHES_DIR"/*.patch 2>/dev/null | sed -n 's|^+++ b/||p' | sort -u)"
	[ -z "$(comm -23 <(printf '%s\n' "$changed") <(printf '%s\n' "$patched"))" ]
}

cmd_record() {
	fingerprint > "$(marker_path)"
	rm -f "$(legacy_marker_path)"
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

# The tree's changes back into patches/vscode/ and patches/vscode-overlay/,
# then recorded: the tree is exactly DevHub's again.
cmd_export() {
	python3 "$REPO_ROOT/scripts/vscode_export.py" "$REPO_ROOT" ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}
	cmd_record
}

cmd_reset() {
	local fp recorded
	fp="$(fingerprint)"
	if [ -n "$fp" ] && [ "${DEVHUB_DISCARD_VSCODE_CHANGES:-0}" != 1 ]; then
		if [ -f "$(marker_path)" ]; then
			recorded="$(cat "$(marker_path)")"
		elif [ -f "$(legacy_marker_path)" ]; then
			# Recorded by the scripts before the overlay existed, so compared
			# in the format it was written in.
			recorded="$(cat "$(legacy_marker_path)")"
			[ "$(legacy_fingerprint)" = "$recorded" ] && recorded="$fp"
		elif only_patched_files_changed; then
			# A tree patched before the marker existed: it has no record, so
			# accept it when it changes nothing the patches do not touch.
			recorded="$fp"
		else
			recorded=""
		fi
		if [ "$fp" != "$recorded" ]; then
			{
				echo "vscode-submodule.sh: vscode/ has changes that are not (only) DevHub's patches and overlay:"
				git -C "$VSCODE_DIR" status --short --untracked-files=all | sed 's/^/  /'
				echo "Resetting would discard them. Keep them (scripts/vscode-submodule.sh export"
				echo "writes edits to DevHub's own changes back; git -C vscode stash, or a branch),"
				echo "or discard them with: git -C vscode checkout -- . && git -C vscode clean -fd"
				echo "(or rerun with DEVHUB_DISCARD_VSCODE_CHANGES=1)."
			} >&2
			exit 1
		fi
	fi
	if [ -n "$(git -C "$VSCODE_DIR" status --porcelain)" ]; then
		git -C "$VSCODE_DIR" checkout -- .
		git -C "$VSCODE_DIR" clean -fdq
	fi
	[ -z "$(git -C "$VSCODE_DIR" status --porcelain)" ] || die "vscode/ is still not clean after reverting the DevHub patches"
	cmd_record
}

cmd_sync() {
	local pinned current old_version
	pinned="$(git -C "$REPO_ROOT" ls-files -s -- vscode | awk '{print $2}')"
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
	cmd_record
	echo "updated vscode: ${current:0:11} (VS Code $old_version) → ${pinned:0:11} (VS Code $(vscode_version))"
}

case "${1:-}" in
	sync) cmd_sync ;;
	reset) cmd_reset ;;
	record) cmd_record ;;
	export) cmd_export ;;
	source-state) cmd_source_state ;;
	*) echo "usage: $(basename "$0") sync|reset|record|export|source-state" >&2; exit 2 ;;
esac
