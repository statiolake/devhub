#!/usr/bin/env bash
# Decide whether the VS Code submodule has an upstream release to move to.
#
# Everything the bump workflow needs to know before it starts a macOS runner is
# decided here, in one script that runs anywhere and needs neither the submodule
# checked out nor a build, so the decision can be checked by running it rather
# than by reading a workflow's `if:` expressions.
#
#   scripts/vscode-bump-plan.sh
#
# Prints these on stdout, and appends them to $GITHUB_OUTPUT when set:
#
#   bump=true|false   whether to open a bump branch at all
#   current=<tag>     the release tag the submodule is pinned to now
#   latest=<tag>      the newest stable upstream release
#   branch=<name>     the branch that bump would use
#   reason=<sentence> why, in words, for the run's log
#
# "Stable" is `releases/latest` minus the `-insider` names: upstream publishes
# insider builds as releases too, and DevHub ships what users get.
#
# The pinned tag is read from the gitlink the parent repo records — the commit
# `git add vscode` stored — and named by asking upstream which tag points at it.
# That is deliberately not `git -C vscode describe`: the submodule's working
# tree is patched and re-checked-out constantly, and a plan built from what
# happens to be checked out rather than from what is committed would propose a
# bump the repository does not need.
#
# Needs `gh` authenticated (GH_TOKEN in the workflow) and network access.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM=https://github.com/microsoft/vscode.git

emit() {
	echo "$1"
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		echo "$1" >> "$GITHUB_OUTPUT"
	fi
}

PINNED="$(git -C "$REPO_ROOT" rev-parse HEAD:vscode)"
CURRENT="$(
	git ls-remote --tags "$UPSTREAM" \
		| awk -v sha="$PINNED" '$1 == sha { print $2 }' \
		| sed 's#^refs/tags/##' \
		| grep -v -- '-insider$' \
		| sort -V | tail -1
)"
if [ -z "$CURRENT" ]; then
	# The submodule is supposed to sit on a release tag. Somewhere between an
	# upstream release and here it does not, and guessing which release this
	# commit belongs to would open a pull request nobody can review.
	echo "the pinned VS Code commit $PINNED is not a stable upstream release tag" >&2
	exit 1
fi

LATEST="$(gh api repos/microsoft/vscode/releases/latest --jq '.tag_name')"
case "$LATEST" in
	*-insider)
		# releases/latest is meant to be the stable one. If it ever is not, stop
		# rather than pin the app to an insider build.
		echo "upstream's latest release is $LATEST, which is not a stable tag" >&2
		exit 1
		;;
esac
BRANCH="bump/vscode-$LATEST"

emit "current=$CURRENT"
emit "latest=$LATEST"
emit "branch=$BRANCH"

decide() {
	emit "bump=$1"
	emit "reason=$2"
	exit 0
}

if [ "$CURRENT" = "$LATEST" ]; then
	decide false "the submodule is already on $LATEST"
fi

# `sort -V` puts the older version first. Upstream only moves forward, but a
# hand-pinned submodule ahead of a stale releases/latest would otherwise be
# rolled back by a bot in the night.
NEWEST="$(printf '%s\n%s\n' "$CURRENT" "$LATEST" | sort -V | tail -1)"
if [ "$NEWEST" != "$LATEST" ]; then
	decide false "the submodule is on $CURRENT, ahead of upstream's latest release $LATEST"
fi

if git -C "$REPO_ROOT" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
	decide false "$BRANCH already exists on the remote"
fi

if [ "$(gh pr list --head "$BRANCH" --state open --json number --jq 'length')" != "0" ]; then
	decide false "a pull request for $BRANCH is already open"
fi

decide true "upstream released $LATEST; the submodule is on $CURRENT"
