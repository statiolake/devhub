#!/usr/bin/env bash
# Keep the VS Code submodule's checkout in step with the commit the superproject
# pins, without ever throwing away an edit DevHub did not make.
#
#   scripts/vscode-submodule.sh sync          put vscode/ on the pinned commit
#   scripts/vscode-submodule.sh reset         take DevHub's changes back off
#   scripts/vscode-submodule.sh is-applied    exit 0 when vscode/ already is the
#                                             pinned commit + the current
#                                             patches + overlay (nothing to do)
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
# scripts/apply-vscode-patches.sh records the tree (as a git tree id, in
# devhub-applied-trees inside the submodule's git dir; scripts/vscode_state.py).
# `reset` goes ahead only when every file it would revert or delete holds
# content some DevHub tree held at that path: a recorded one (so any earlier
# version of the patches — the state a `git pull` of new patches finds — and a
# run cut short), what the current patches make of the commit, or what the
# patches of a recent superproject commit make of it. Anything else is an edit
# nobody exported, and stops the run with exactly those files named. Ignored
# files (node_modules, out*, .build) are outside all of this and never touched.
# Each reset of a changed tree also keeps it as a commit on
# refs/devhub/vscode-before-reset (with a reflog) in vscode/, so nothing a reset
# took is gone for good. The single fingerprint the scripts kept before
# (devhub-patched-tree.v2) is still written and still accepted.
#
# Why `export`: an edit made in vscode/ (where it compiles and its tests run)
# has to go back to where it is kept. `export` splits the tree's changes the
# way scripts/apply-vscode-patches.sh joins them — a change to a file upstream
# has goes into the one patch that changes that file, a file upstream does not
# have goes into the overlay — and refuses, changing nothing and naming each
# path, whenever that is not a mechanical decision: see scripts/vscode_export.py.
#
# DEVHUB_DISCARD_VSCODE_CHANGES=1, or --discard-vscode-changes after the
# command, resets regardless, for when the edits really are disposable (the copy
# on refs/devhub/vscode-before-reset is still made).
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

# Both records: vscode_state.py's log of every tree an apply step left (what
# `reset` now goes by), and the fingerprint of this one, which is what scripts
# from before that log read, so going back to an older checkout still works.
cmd_record() {
	fingerprint > "$(marker_path)"
	rm -f "$(legacy_marker_path)"
	state record "${1:-apply}"
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
	cmd_record export
}

# vscode_state.py, with the build-written paths left out of the comparison.
state() {
	local args=(--root "$REPO_ROOT") f
	for f in ${BUILD_WRITTEN[@]+"${BUILD_WRITTEN[@]}"}; do
		args+=(--exclude "$f")
	done
	python3 "$REPO_ROOT/scripts/vscode_state.py" "${args[@]}" "$@"
}

# What the scripts before vscode_state.py accepted: a tree matching the
# fingerprint they recorded, or (with no record at all) one that changes only
# files the patches change and adds only overlay files.
legacy_accepts() {
	local fp recorded
	fp="$(fingerprint)"
	if [ -f "$(marker_path)" ]; then
		recorded="$(cat "$(marker_path)")"
	elif [ -f "$(legacy_marker_path)" ]; then
		recorded="$(cat "$(legacy_marker_path)")"
		[ "$(legacy_fingerprint)" = "$recorded" ] && recorded="$fp"
	elif [ ! -s "$(git_path devhub-applied-trees)" ] && only_patched_files_changed; then
		recorded="$fp"
	else
		recorded=""
	fi
	[ -n "$fp" ] && [ "$fp" = "$recorded" ]
}

# Take the tree back to its commit, if that loses nothing: vscode_state.py
# classify says whether every changed file holds content a DevHub apply made
# (see its docstring). Ignored files — node_modules, out*, .build, the build
# caches — are never touched: no `git clean -x`.
cmd_reset() {
	local verdict files backup
	verdict="$(state classify)" || die "could not read vscode/'s state"
	files="$(printf '%s\n' "$verdict" | sed 1d)"
	verdict="$(printf '%s\n' "$verdict" | head -1)"
	if [ "$verdict" = unknown ] && legacy_accepts; then
		verdict=devhub
	fi
	case "$verdict" in
		clean) ;;
		current | devhub) state backup "reset ($verdict)" >/dev/null ;;
		unknown)
			if [ "${DEVHUB_DISCARD_VSCODE_CHANGES:-0}" = 1 ]; then
				backup="$(state backup "discarded (DEVHUB_DISCARD_VSCODE_CHANGES)")"
				echo "discarding vscode/ edits that were not exported:"
				printf '%s\n' "$files" | sed 's/^/  /'
				echo "(kept as commit ${backup:0:12} in vscode/: git -C vscode show --stat ${backup:0:12})"
			else
				{
					echo "vscode-submodule.sh: vscode/ has edits that are not in patches/vscode or"
					echo "patches/vscode-overlay yet, so it was left as it is:"
					printf '%s\n' "$files" | sed 's/^/  /'
					echo "Keep them:     scripts/vscode-submodule.sh export   (then build again)"
					echo "Discard them:  build again with --discard-vscode-changes"
					echo "               (or DEVHUB_DISCARD_VSCODE_CHANGES=1); a copy is kept on"
					echo "               refs/devhub/vscode-before-reset in vscode/."
				} >&2
				exit 1
			fi
			;;
		*) die "unexpected state '$verdict'" ;;
	esac
	if [ -n "$(git -C "$VSCODE_DIR" status --porcelain --untracked-files=all)" ]; then
		git -C "$VSCODE_DIR" reset -q --hard HEAD
		git -C "$VSCODE_DIR" clean -fdq
	fi
	[ -z "$(git -C "$VSCODE_DIR" status --porcelain)" ] || die "vscode/ is still not clean after reverting the DevHub patches"
	cmd_record reset
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
	# Nothing to record, unless the record is in an older format.
	if [ ! -f "$(marker_path)" ] || [ -f "$(legacy_marker_path)" ]; then
		cmd_record current
	fi
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
	cmd_record sync
	echo "updated vscode: ${current:0:11} (VS Code $old_version) → ${pinned:0:11} (VS Code $(vscode_version))"
}

CMD="${1:-}"
[ $# -gt 0 ] && shift
for arg in "$@"; do
	case "$arg" in
		--discard-vscode-changes) export DEVHUB_DISCARD_VSCODE_CHANGES=1 ;;
		*) echo "usage: $(basename "$0") sync|reset|is-applied|record|export|source-state [--discard-vscode-changes]" >&2; exit 2 ;;
	esac
done
case "$CMD" in
	sync) cmd_sync ;;
	reset) cmd_reset ;;
	is-applied) cmd_is_applied ;;
	record) cmd_record apply ;;
	export) cmd_export ;;
	source-state) cmd_source_state ;;
	*) echo "usage: $(basename "$0") sync|reset|is-applied|record|export|source-state [--discard-vscode-changes]" >&2; exit 2 ;;
esac
