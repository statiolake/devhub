#!/usr/bin/env bash
# Keep the VS Code submodule's checkout in step with the commit the superproject
# pins, without ever throwing away an edit DevHub did not make.
#
#   scripts/vscode-submodule.sh sync     put vscode/ on the pinned commit
#   scripts/vscode-submodule.sh reset    take the DevHub patches back off
#   scripts/vscode-submodule.sh record   note the tree as "DevHub's own edits"
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
# (patches/vscode is applied onto it, hence `ignore = dirty` in .gitmodules),
# so "dirty" cannot tell DevHub's edits from a developer's. After every patch
# scripts/apply-vscode-patches.sh records a fingerprint of the tree's changes
# inside the submodule's git dir. A tree whose changes match it, or that has
# none, is DevHub's to reset; anything else stops with the files named. A
# fresh checkout (CI) has no changes, so none of this costs it anything.
#
# DEVHUB_DISCARD_VSCODE_CHANGES=1 resets regardless, for when the edits really
# are disposable.
set -euo pipefail

REPO_ROOT="${DEVHUB_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VSCODE_DIR="$REPO_ROOT/vscode"

die() { printf 'vscode-submodule.sh: %s\n' "$1" >&2; exit 1; }

vscode_version() {
	sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$VSCODE_DIR/package.json" 2>/dev/null | head -1
}

marker_path() {
	local p
	p="$(git -C "$VSCODE_DIR" rev-parse --git-path devhub-patched-tree)"
	case "$p" in /*) ;; *) p="$VSCODE_DIR/$p" ;; esac
	printf '%s' "$p"
}

# Every tracked change and every untracked, non-ignored file, hashed. Empty
# output means the tree is exactly its HEAD.
fingerprint() {
	local changes
	changes="$(
		git -C "$VSCODE_DIR" diff --binary HEAD
		git -C "$VSCODE_DIR" ls-files --others --exclude-standard
	)"
	[ -z "$changes" ] && return 0
	printf '%s' "$changes" | git hash-object --stdin
}

# Whether every change in the tree is to a file patches/vscode modifies.
only_patched_files_changed() {
	local changed patched
	[ -z "$(git -C "$VSCODE_DIR" ls-files --others --exclude-standard)" ] || return 1
	changed="$(git -C "$VSCODE_DIR" diff --name-only HEAD | sort -u)"
	patched="$(cat "$REPO_ROOT"/patches/vscode/*.patch 2>/dev/null | sed -n 's|^+++ b/||p' | sort -u)"
	[ -z "$(comm -23 <(printf '%s\n' "$changed") <(printf '%s\n' "$patched"))" ]
}

cmd_record() {
	fingerprint > "$(marker_path)"
}

cmd_reset() {
	local fp recorded
	fp="$(fingerprint)"
	if [ -n "$fp" ] && [ "${DEVHUB_DISCARD_VSCODE_CHANGES:-0}" != 1 ]; then
		if [ -f "$(marker_path)" ]; then
			recorded="$(cat "$(marker_path)")"
		elif only_patched_files_changed; then
			# A tree patched before the marker existed: it has no record, so
			# accept it when it changes nothing the patches do not touch.
			recorded="$fp"
		else
			recorded=""
		fi
		if [ "$fp" != "$recorded" ]; then
			{
				echo "vscode-submodule.sh: vscode/ has changes that are not (only) the DevHub patches:"
				git -C "$VSCODE_DIR" status --short | sed 's/^/  /'
				echo "Resetting would discard them. Keep them (git -C vscode stash, or a branch),"
				echo "or discard them with: git -C vscode checkout -- . && git -C vscode clean -fd"
				echo "(or rerun with DEVHUB_DISCARD_VSCODE_CHANGES=1)."
			} >&2
			exit 1
		fi
	fi
	if [ -n "$fp" ]; then
		git -C "$VSCODE_DIR" checkout -- .
		git -C "$VSCODE_DIR" clean -fdq
	fi
	[ -z "$(fingerprint)" ] || die "vscode/ is still not clean after reverting the DevHub patches"
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
	*) echo "usage: $(basename "$0") sync|reset|record" >&2; exit 2 ;;
esac
