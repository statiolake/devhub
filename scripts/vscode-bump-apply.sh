#!/usr/bin/env bash
# Move the VS Code submodule to an upstream release tag and find out what breaks.
#
#   scripts/vscode-bump-apply.sh <tag> <report-dir>
#
# Stages the submodule bump, re-applies patches/vscode/*.patch on top of it, and
# runs `pnpm run check` against the result. Into <report-dir> it writes:
#
#   patches.log    outcome.env   patches=ok|failed
#   provision.log                provision=ok|failed|skipped
#   check.log                    check=ok|failed|skipped
#
# Those three failures are the whole point of the script, so it exits 0 when
# they happen: the bump workflow turns the report into a draft pull request with
# the logs in its body, and a person reads it. Nothing here is swallowed — every
# outcome is written down and ends up in front of somebody. Anything *else*
# going wrong (a tag that does not exist, a submodule that will not check out)
# is a broken assumption and exits non-zero the way it should.
#
# The three are separate because a bump breaks at three distinguishable places,
# and "the checks went red" would not say which: a patch that no longer applies
# to the moved source, an upstream build that no longer completes here, and
# DevHub's own code disagreeing with the new VS Code. Only the last is a code
# change on our side.
set -euo pipefail

if [ "$#" -ne 2 ]; then
	echo "usage: $(basename "$0") <tag> <report-dir>" >&2
	exit 2
fi
TAG="$1"
REPORT="$2"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
mkdir -p "$REPORT"

step() { printf '\n==> %s\n' "$1"; }

step "VS Code submodule -> $TAG"
git -C "$REPO_ROOT" submodule update --init --depth 1 -- vscode
git -C "$VSCODE_DIR" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
git -C "$VSCODE_DIR" checkout --detach "refs/tags/$TAG"
git -C "$REPO_ROOT" add vscode

# The patches are applied to the working tree, which `git add vscode` above has
# already recorded, so the staged bump is the clean tag and the patched tree
# stays uncommitted — exactly the state provisioning expects.
step "patches/vscode"
if "$REPO_ROOT/scripts/apply-vscode-patches.sh" > "$REPORT/patches.log" 2>&1; then
	PATCHES=ok
else
	PATCHES=failed
fi
cat "$REPORT/patches.log"

# `pnpm run check` needs a *provisioned* submodule, not merely a checked-out
# one: typecheck resolves DevHub's main process against the types in
# vscode/node_modules, and the tests read the tree the patches produced. This is
# the whole npm ci and both compiles against a VS Code nobody has built here
# before, so it is the long pole of the job — and the step most worth reporting
# on its own, since an upstream build that stops working is not our bug to fix
# in the same way a failing test is.
#
# Provisioning re-applies the patches itself; on a tree they have already been
# applied to that is a reset and a replay, which is why running both is fine.
step "provision"
PROVISION=skipped
CHECK=skipped
if [ "$PATCHES" = ok ]; then
	if "$REPO_ROOT/scripts/provision-vscode.sh" > "$REPORT/provision.log" 2>&1; then
		PROVISION=ok
	else
		PROVISION=failed
	fi
	tail -n 30 "$REPORT/provision.log"
else
	echo "skipped: the patches did not apply" > "$REPORT/provision.log"
fi

# A check run against a tree the earlier steps did not finish would fail for
# reasons that say nothing about the bump, so it is skipped rather than run and
# misreported. "skipped" is a distinct outcome in the report for that reason.
step "pnpm run check"
if [ "$PROVISION" = ok ]; then
	if (cd "$REPO_ROOT" && pnpm install --frozen-lockfile && pnpm run check) > "$REPORT/check.log" 2>&1; then
		CHECK=ok
	else
		CHECK=failed
	fi
	tail -n 60 "$REPORT/check.log"
else
	echo "skipped: the submodule was not provisioned" > "$REPORT/check.log"
fi

{
	echo "patches=$PATCHES"
	echo "provision=$PROVISION"
	echo "check=$CHECK"
} > "$REPORT/outcome.env"
cat "$REPORT/outcome.env"
