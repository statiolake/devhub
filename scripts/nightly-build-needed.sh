#!/usr/bin/env bash
# Decide whether tonight's nightly has anything new to package.
#
# The nightly release is one rolling prerelease, replaced whole on every run.
# Rebuilding it from a commit it was already built from produces a byte-for-byte
# equivalent app under a new timestamp, spends two hours of a macOS runner, and
# breaks every existing download link on the way. So: build when the commit
# being packaged is not the commit the standing `nightly` release was cut from,
# and when there is no such release at all.
#
#   scripts/nightly-build-needed.sh <sha>
#
# Prints `needed=true|false` and `reason=<sentence>` on stdout, and appends the
# same lines to $GITHUB_OUTPUT when the workflow set one. Run it by hand against
# any sha to see what the schedule would decide.
#
# Needs `gh` authenticated against this repository (GH_TOKEN in the workflow).
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: $(basename "$0") <sha>" >&2
	exit 2
fi
SHA="$1"

emit() {
	echo "$1"
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		echo "$1" >> "$GITHUB_OUTPUT"
	fi
}

decide() {
	emit "needed=$1"
	emit "reason=$2"
	exit 0
}

if ! gh release view nightly >/dev/null 2>&1; then
	decide true "there is no nightly release yet"
fi

# What the standing release was built from. `gh release create --target <sha>`
# writes a lightweight tag, so the tag ref points straight at the commit; the
# release's own target_commitish records the same sha and is the answer when a
# tag has been moved or deleted underneath the release.
RELEASED="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/nightly" --jq '.object.sha' 2>/dev/null || true)"
if [ -z "$RELEASED" ]; then
	RELEASED="$(gh release view nightly --json targetCommitish --jq '.targetCommitish')"
fi

if [ "$RELEASED" = "$SHA" ]; then
	decide false "the nightly release is already built from $SHA"
fi
decide true "main moved to $SHA; the nightly release stands at $RELEASED"
