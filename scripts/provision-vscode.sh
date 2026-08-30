#!/usr/bin/env bash
# Prepare the pinned VS Code submodule so the DevHub desktop app can run against
# it: check out the submodule, put the Node version VS Code's build requires in a
# gitignored toolchain dir, install VS Code's own npm dependencies and compile.
#
# VS Code is consumed, never edited. Everything this script produces lives inside
# vscode/ (npm-managed, gitignored by the submodule itself) or vscode-toolchain/.
#
# Idempotent: each step is skipped when its output already exists.
#   --force   redo every step regardless.
set -euo pipefail

FORCE=0
for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
		*) echo "usage: $(basename "$0") [--force]" >&2; exit 2 ;;
	esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$REPO_ROOT/vscode"
TOOLCHAIN_DIR="$REPO_ROOT/vscode-toolchain"

step() { printf '\n==> %s\n' "$1"; }

# --- 1. the submodule ------------------------------------------------------
step "VS Code submodule"
if [ "$FORCE" = 1 ] || [ ! -f "$VSCODE_DIR/package.json" ]; then
	git -C "$REPO_ROOT" submodule update --init --depth 1 -- vscode
else
	echo "already checked out: $(git -C "$VSCODE_DIR" rev-parse --short HEAD)"
fi

# --- 2. the Node the VS Code build requires --------------------------------
# The machine default is whatever the developer runs; VS Code's build refuses
# anything but the version in vscode/.nvmrc, so fetch exactly that one here.
NODE_VERSION="$(tr -d '[:space:]' < "$VSCODE_DIR/.nvmrc")"
case "$(uname -s)" in
	Darwin) NODE_OS=darwin ;;
	Linux) NODE_OS=linux ;;
	*) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
	arm64 | aarch64) NODE_ARCH=arm64 ;;
	x86_64) NODE_ARCH=x64 ;;
	*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIST="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}"
NODE_HOME="$TOOLCHAIN_DIR/$NODE_DIST"

step "Node $NODE_VERSION toolchain"
if [ "$FORCE" = 1 ] || [ ! -x "$NODE_HOME/bin/node" ]; then
	mkdir -p "$TOOLCHAIN_DIR"
	TARBALL="$TOOLCHAIN_DIR/$NODE_DIST.tar.gz"
	curl -fsSL -o "$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
	tar -xzf "$TARBALL" -C "$TOOLCHAIN_DIR"
	rm -f "$TARBALL"
	echo "installed $("$NODE_HOME/bin/node" --version)"
else
	echo "already installed: $("$NODE_HOME/bin/node" --version)"
fi
export PATH="$NODE_HOME/bin:$PATH"

# --- 3. VS Code's own dependencies -----------------------------------------
step "npm ci in vscode/"
if [ "$FORCE" = 1 ] || [ ! -d "$VSCODE_DIR/node_modules/electron" ]; then
	(cd "$VSCODE_DIR" && npm ci)
else
	echo "vscode/node_modules already installed"
fi

# --- 3b. the patches DevHub cannot avoid ------------------------------------
# VS Code is consumed, never edited: everything DevHub needs is a subclass, a
# service registration, or a replaced Electron static. patches/vscode/ is the
# one exception, for what none of those can reach. Each patch says why in its
# own body; the working tree is reset first so this stays idempotent.
step "patches/vscode"
PATCH_STAMP="$VSCODE_DIR/.build/devhub-patches.stamp"
PATCH_STATE="$(cat "$REPO_ROOT"/patches/vscode/*.patch 2>/dev/null | shasum | cut -d' ' -f1)"
git -C "$VSCODE_DIR" checkout -- .
for patch in "$REPO_ROOT"/patches/vscode/*.patch; do
	[ -e "$patch" ] || continue
	echo "applying $(basename "$patch")"
	git -C "$VSCODE_DIR" apply "$patch"
done

# --- 4. compile ------------------------------------------------------------
step "compile vscode/"
if [ "$FORCE" = 1 ] \
	|| [ ! -f "$VSCODE_DIR/out/vs/code/electron-main/main.js" ] \
	|| [ "$(cat "$PATCH_STAMP" 2>/dev/null)" != "$PATCH_STATE" ]; then
	(cd "$VSCODE_DIR" && npm run compile)
	mkdir -p "$(dirname "$PATCH_STAMP")"
	printf '%s' "$PATCH_STATE" > "$PATCH_STAMP"
else
	echo "vscode/out already compiled from the current patches"
fi

# --- 5. the Electron our main process runs in ------------------------------
# Our main process runs inside VS Code's own Electron: the native modules in
# vscode/node_modules are built for exactly this binary. npm ci does not fetch
# it; VS Code's `electron` script does.
step "Electron runtime"
ELECTRON_APP="$VSCODE_DIR/.build/electron"
if [ "$FORCE" = 1 ] || [ ! -d "$ELECTRON_APP" ]; then
	(cd "$VSCODE_DIR" && npm run electron)
fi
if [ ! -d "$ELECTRON_APP" ]; then
	echo "missing $ELECTRON_APP — 'npm run electron' did not produce it" >&2
	exit 1
fi
echo "Electron $(cat "$VSCODE_DIR/.build/electron/version" 2>/dev/null || echo '(version file missing)')"

# --- 6. the built-in extension set DevHub starts with ---------------------
# DevHub's own integration ships as a built-in so that its workbench defaults
# (contributes.configurationDefaults) are in effect and cannot be uninstalled.
# See the script for why the whole set has to be staged.
step "built-in extensions"
(cd "$REPO_ROOT/extensions/devhub-bridge" && node scripts/build.mjs)
"$REPO_ROOT/scripts/stage-builtin-extensions.sh"

printf '\nprovisioned.\n'
