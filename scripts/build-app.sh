#!/usr/bin/env bash
# Build DevHub.app from a clean clone, in one command.
#
# This is what `pnpm build` at the repository root runs, and it is the only
# entry point: the nightly workflow calls it too, so CI and a developer's Mac
# execute the same steps in the same order rather than two lists that drift.
# Everything it does is delegated — provisioning to scripts/provision-vscode.sh,
# packaging to scripts/package-nightly.py — so no step is written down twice.
#
#   dist/DevHub.app
#   dist/DevHub-darwin-arm64-<date>-<sha>.zip
#
# ## Which prerequisites this satisfies, and which it refuses to
#
# The rule is the one the first run has to pass: if a missing input can be
# produced from what is already in the clone, produce it, because a person who
# just cloned the repository cannot be expected to know it was needed. If it
# needs something from outside the clone that we cannot install without taking
# over the machine, say what is missing in one sentence and stop.
#
# Satisfied automatically:
#   * the pnpm workspace's node_modules       (`pnpm install`)
#   * the VS Code submodule, its Node
#     toolchain, its npm dependencies, the
#     DevHub patches and both compiles       (scripts/provision-vscode.sh)
#   * the DevHub packages themselves         (`pnpm run build:packages`)
#
# Refused with a message:
#   * macOS on Apple Silicon — the bundle this produces runs nowhere else
#   * the Xcode command line tools — packaging signs and copies the bundle with
#     `codesign` and `ditto`, and installing them opens a system dialog that is
#     the user's to answer
#   * python3 — the packaging script is Python, and which Python a machine
#     should have is not this script's decision
#   * pnpm — it is the package manager that invoked us in the normal case, but
#     the script is also runnable directly
#
# Node's own version is deliberately *not* checked: the only Node this build is
# picky about is the one VS Code's build requires, and provisioning fetches
# exactly that one into vscode-toolchain/ rather than using the machine's.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { printf '\nbuild-app.sh: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "DevHub.app is a macOS bundle; this machine is $(uname -s)."
[ "$(uname -m)" = "arm64" ] || die "DevHub is built for Apple Silicon; this machine is $(uname -m)."
xcode-select -p >/dev/null 2>&1 || die "the Xcode command line tools are missing. Install them with: xcode-select --install"
command -v python3 >/dev/null 2>&1 || die "python3 is missing. Install it (Xcode command line tools ship one, as does Homebrew's python)."
command -v pnpm >/dev/null 2>&1 || die "pnpm is missing. Enable it with: corepack enable && corepack prepare pnpm@11.20.0 --activate"

# The name the nightly release uses, so a local build and a downloaded one are
# told apart by their contents rather than by where they came from.
DATE="$(date -u +%Y%m%d)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
ZIP_NAME="DevHub-darwin-arm64-${DATE}-${SHA}.zip"

# CI restores its own cache and runs these two steps itself before calling us;
# both are idempotent, so running them again there is a few seconds, not a
# rebuild. Locally they are the difference between one command and four.
printf '\n==> workspace dependencies\n'
pnpm install --frozen-lockfile

scripts/provision-vscode.sh

printf '\n==> DevHub packages\n'
pnpm run build:packages

printf '\n==> DevHub.app\n'
exec scripts/package-nightly.py --out-dir dist --zip --zip-name "$ZIP_NAME" "$@"
