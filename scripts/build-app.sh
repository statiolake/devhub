#!/usr/bin/env bash
# Build DevHub.app from a clean clone, in one command.
#
# This is what `pnpm build` at the repository root runs, and it is the only
# entry point: the nightly workflow calls it too, so CI and a developer's Mac
# execute the same steps in the same order. Packaging itself is
# scripts/package-nightly.py; this satisfies what it needs first.
#
#   dist/DevHub.app
#   dist/DevHub-darwin-arm64-<date>-<sha>.zip
#
# It assembles the bundle and stops there: it does not start what it made. A
# DevHub that starts takes over the machine's tmux socket and the Agents on it,
# and a person who typed `pnpm build` did not ask for that. Whether the bundle
# runs is a separate question, asked by `pnpm run smoke`
# (scripts/smoke_packaged_app.py) and by CI on every bundle it packages.
#
# Satisfied automatically:
#   * the pnpm workspace's node_modules, npm's Electron among them
#                                            (`pnpm install`)
#   * DevHub's build                         (`pnpm run build:packages`)
#   * the speech recogniser's programs the GUI Agent composer dictates with,
#     in dist/whisper — package-nightly.py runs scripts/build_whisper.py when
#     it is missing or stale: needs cmake, compiles whisper.cpp with Metal (a
#     few minutes, once), cached under ~/.cache/devhub/whisper. Without cmake
#     it stops, naming it. No model is bundled: the app downloads it when the
#     person turns voice input on. `--without-whisper` packages without it.
#
# Refused with a message:
#   * anything but macOS on Apple Silicon — the bundle runs nowhere else
#   * the Xcode command line tools — packaging signs and copies the bundle with
#     `codesign` and `ditto`, and installing them opens a system dialog that is
#     the user's to answer
#   * python3 and pnpm
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { printf '\nbuild-app.sh: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "DevHub.app is a macOS bundle; this machine is $(uname -s)."
[ "$(uname -m)" = "arm64" ] || die "DevHub is built for Apple Silicon; this machine is $(uname -m)."
xcode-select -p >/dev/null 2>&1 || die "the Xcode command line tools are missing. Install them with: xcode-select --install"
command -v python3 >/dev/null 2>&1 || die "python3 is missing. Install it (Xcode command line tools ship one, as does Homebrew's python)."
command -v pnpm >/dev/null 2>&1 || die "pnpm is missing. Enable it with: corepack enable (it reads the version from package.json)"

# The name the nightly release uses, so a local build and a downloaded one are
# told apart by their contents rather than by where they came from.
DATE="$(date -u +%Y%m%d)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
ZIP_NAME="DevHub-darwin-arm64-${DATE}-${SHA}.zip"

printf '\n==> workspace dependencies\n'
pnpm install --frozen-lockfile
apps/desktop/scripts/electron-path.sh >/dev/null

printf '\n==> DevHub packages\n'
pnpm run build:packages

# `--no-zip` is ours, not package-nightly.py's: stop at dist/DevHub.app. The
# per-push CI build uses it — its bundle is tested and thrown away, so the zip
# would be minutes spent on an archive nobody downloads.
ZIP_ARGS=(--zip --zip-name "$ZIP_NAME")
PASS=()
for arg in "$@"; do
	if [ "$arg" = "--no-zip" ]; then
		ZIP_ARGS=()
	else
		PASS+=("$arg")
	fi
done

printf '\n==> DevHub.app\n'
# (The `${a[@]+...}` spelling: macOS's bash 3.2 calls an empty array unbound
# under `set -u`.)
exec scripts/package-nightly.py --out-dir dist ${ZIP_ARGS[@]+"${ZIP_ARGS[@]}"} ${PASS[@]+"${PASS[@]}"}
