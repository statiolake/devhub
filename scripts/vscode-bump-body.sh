#!/usr/bin/env bash
# Write the body of the VS Code bump pull request.
#
#   scripts/vscode-bump-body.sh <old-tag> <new-tag> <report-dir>
#
# <report-dir> is what scripts/vscode-bump-apply.sh produced. The body says what
# moved, what the patches did, what `pnpm run check` did, and — when either went
# wrong — the tail of the log, so the person who opens the pull request can see
# the failure without opening the run.
set -euo pipefail

if [ "$#" -ne 3 ]; then
	echo "usage: $(basename "$0") <old-tag> <new-tag> <report-dir>" >&2
	exit 2
fi
OLD="$1"
NEW="$2"
REPORT="$3"

# shellcheck source=/dev/null
. "$REPORT/outcome.env"
# Named here so a report missing either half stops now, with a sentence, rather
# than rendering a pull request body with an empty cell in the result table.
PATCHES="${patches:?outcome.env recorded no patch result}"
PROVISION="${provision:?outcome.env recorded no provision result}"
CHECK="${check:?outcome.env recorded no check result}"

verdict() {
	case "$1" in
		ok) echo "passed" ;;
		failed) echo "**failed**" ;;
		skipped) echo "not run" ;;
		*) echo "$1" ;;
	esac
}

excerpt() {
	printf '\n<details><summary>%s (last 60 lines)</summary>\n\n```\n' "$1"
	tail -n 60 "$2"
	printf '```\n\n</details>\n'
}

cat <<BODY
Moves the \`vscode/\` submodule from **$OLD** to **$NEW**.

* Upstream release notes: <https://github.com/microsoft/vscode/releases/tag/$NEW>
* Comparison: <https://github.com/microsoft/vscode/compare/$OLD...$NEW>

| step | result |
| --- | --- |
| \`patches/vscode/*.patch\` | $(verdict "$PATCHES") |
| \`scripts/provision-vscode.sh\` | $(verdict "$PROVISION") |
| \`pnpm run check\` | $(verdict "$CHECK") |
BODY

if [ "$PATCHES" != ok ]; then
	excerpt "Patch application" "$REPORT/patches.log"
fi
if [ "$PROVISION" = failed ]; then
	excerpt "Provisioning" "$REPORT/provision.log"
fi
if [ "$CHECK" = failed ]; then
	excerpt "pnpm run check" "$REPORT/check.log"
	cat <<'NOTE'

If the failure is `product_metadata_test.py`, an API proposal DevHub grants in
`scripts/product_metadata.py` no longer exists in this VS Code — upstream
finished or renamed it. The fix is in that table, not in the test.
NOTE
fi

cat <<'FOOTER'

---

Opened by the `vscode-bump` workflow. It does not merge anything; review the
diff and the check result before you do.
FOOTER
