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
# The published path is a *symlink* to a content-addressed generation
# directory, and this script never writes through it. That is the whole point:
# every launcher runs this script, several DevHub instances are routinely
# started minutes apart, and the previous version rebuilt the published
# directory in place — `rm -rf` followed by ~96 `ln -s`. Any instance that
# scanned its built-ins during that window saw an empty or half-filled set and
# came up with no built-in extensions at all: no TypeScript grammar, so no
# syntax highlighting, and third-party extensions failing with "Unknown
# language ... typescript". The scan is not cached (`extensions.builtin.cache`
# is keyed on the scan input and was absent), so the damage lasted exactly as
# long as that process — which is what made it look intermittent and
# unreproducible.
#
# Naming the generation after a hash of its contents removes the window rather
# than narrowing it: when the set is unchanged — the overwhelmingly common case
# — this script creates and deletes nothing, and a concurrent launch reads a
# directory nobody is touching. When the set does change, the new generation is
# populated off to the side and published with a single rename(2), so the path
# an instance resolves is always a complete set. Old generations are left
# behind for whatever is still running and reaped only once they are a week
# stale.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_EXTENSIONS="$REPO_ROOT/vscode/extensions"
BRIDGE="$REPO_ROOT/extensions/devhub-bridge"
BUILD="$REPO_ROOT/vscode/.build"
STAGED="$BUILD/devhub-builtin-extensions"
GENERATIONS="$BUILD/devhub-builtin-extensions.generations"

if [ ! -d "$VSCODE_EXTENSIONS" ]; then
	echo "no $VSCODE_EXTENSIONS — run scripts/provision-vscode.sh" >&2
	exit 1
fi
if [ ! -f "$BRIDGE/dist/extension.js" ]; then
	echo "the bridge extension is not built — run 'pnpm --filter @devhub/bridge build'" >&2
	exit 1
fi

# The names to link, in a fixed order so the hash below names the *set* and not
# the order the filesystem happened to hand them over in.
names=()
for entry in "$VSCODE_EXTENSIONS"/*/; do
	[ -f "$entry/package.json" ] || continue
	names+=("$(basename "${entry%/}")")
done
if [ "${#names[@]}" -eq 0 ]; then
	echo "no built-in extensions found in $VSCODE_EXTENSIONS — run scripts/provision-vscode.sh" >&2
	exit 1
fi
IFS=$'\n' names=($(printf '%s\n' "${names[@]}" | LC_ALL=C sort)) || true
unset IFS

# What the generation is: these names, linked out of this checkout, plus
# DevHub's own. Anything that would change the resulting directory has to be in
# here, or a stale generation would be reused.
digest="$(
	printf '%s\n' "$VSCODE_EXTENSIONS" "$BRIDGE" "${names[@]}" |
		shasum -a 256 | cut -d' ' -f1
)"
generation="$GENERATIONS/$digest"

if [ ! -d "$generation" ]; then
	mkdir -p "$GENERATIONS"
	# Populated under a name no other run can pick, so two launches racing on
	# the same digest cannot see each other's half-built directory.
	building="$GENERATIONS/.building.$$"
	rm -rf "$building"
	mkdir -p "$building"
	for name in "${names[@]}"; do
		ln -s "$VSCODE_EXTENSIONS/$name" "$building/$name"
	done
	# DevHub's own, last, so a name clash would be visible rather than silent.
	ln -s "$BRIDGE" "$building/devhub-bridge"

	# Whoever gets there first wins; the loser's copy is identical by
	# construction, so it is simply discarded.
	if ! mv -n "$building" "$generation" 2>/dev/null || [ -d "$building" ]; then
		rm -rf "$building"
	fi
fi

# Publish by rename(2) on the symlink itself, which is atomic and — unlike `mv`
# and `ln -sfn` — never follows the existing link into the directory it points
# at or leaves the path missing in between. An instance resolving the path
# during this call gets either the old generation or the new one, both of them
# complete.
python3 - "$STAGED" "$generation" <<'PY'
import os, sys

published, generation = sys.argv[1], sys.argv[2]
if os.path.realpath(published) == os.path.realpath(generation) and os.path.islink(published):
	raise SystemExit(0)

pending = f"{published}.pending.{os.getpid()}"
if os.path.lexists(pending):
	os.remove(pending)
os.symlink(generation, pending)

# A directory left by an older layout cannot be renamed over; move it aside
# first so the path is a symlink from here on. Nothing reads through it — every
# entry under it is a link to vscode/extensions, which does not move — so an
# instance already running keeps working.
if os.path.isdir(published) and not os.path.islink(published):
	os.rename(published, f"{published}.superseded.{os.getpid()}")

os.replace(pending, published)
PY

# Generations something may still be running against are kept; a week is far
# longer than any DevHub session and shorter than the noise is worth.
find "$GENERATIONS" -maxdepth 1 -mindepth 1 -type d -mtime +7 \
	! -name "$digest" -exec rm -rf {} + 2>/dev/null || true
rm -rf "$STAGED".superseded.* 2>/dev/null || true

echo "staged $(find "$STAGED/" -maxdepth 1 -type l | wc -l | tr -d ' ') built-in extensions in $STAGED -> $generation"
