#!/usr/bin/env bash
# Stage the built-in extension set DevHub's VS Code starts with.
#
# VS Code has no supported way for a *product* to override configuration
# defaults on the desktop: `product.configurationDefaults` has no reader, and
# `environmentService.options.configurationDefaults` is web-only. The one
# supported mechanism is an extension's `contributes.configurationDefaults`, so
# DevHub's own integration — extensions/devhub-bridge — carries the workbench
# settings a view-hosted workbench needs, and has to be *built in* so that a
# person cannot uninstall DevHub's own integration and be left with a broken
# window.
#
# `--builtin-extensions-dir` replaces the whole built-in set rather than adding
# to it (see vscode/src/vs/platform/environment/common/environmentService.ts,
# `builtinExtensionsPath`), so this directory has to contain every one of VS
# Code's own as well. They are symlinked, not copied: the scanner resolves each
# entry's package.json through the link, and a copy of ~90 extensions would be
# a build step nobody wants on every run.
#
# It is staged inside vscode/.build (the submodule's own gitignored build
# directory) because VS Code serves extension resources over `vscode-file:` and
# that protocol only answers for paths under the app root: a directory beside
# the repo made every built-in extension's icons and fonts fail to load.
#
# Idempotent: the directory is rebuilt from scratch each time, which is cheap
# because it is only links.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_EXTENSIONS="$REPO_ROOT/vscode/extensions"
BRIDGE="$REPO_ROOT/extensions/devhub-bridge"
STAGED="$REPO_ROOT/vscode/.build/devhub-builtin-extensions"

if [ ! -d "$VSCODE_EXTENSIONS" ]; then
	echo "no $VSCODE_EXTENSIONS — run scripts/provision-vscode.sh" >&2
	exit 1
fi
if [ ! -f "$BRIDGE/dist/extension.js" ]; then
	echo "the bridge extension is not built — run 'pnpm --filter @devhub/bridge build'" >&2
	exit 1
fi

rm -rf "$STAGED"
mkdir -p "$STAGED"

for entry in "$VSCODE_EXTENSIONS"/*/; do
	[ -f "$entry/package.json" ] || continue
	ln -s "${entry%/}" "$STAGED/$(basename "$entry")"
done

# DevHub's own, last, so a name clash would be visible rather than silent.
ln -s "$BRIDGE" "$STAGED/devhub-bridge"

echo "staged $(find "$STAGED" -maxdepth 1 -type l | wc -l | tr -d ' ') built-in extensions in $STAGED"
