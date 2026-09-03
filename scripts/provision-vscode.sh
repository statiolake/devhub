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
# The pinned commit is the one the *parent repo* records, not whatever the
# submodule's working tree happens to sit on: `submodule update` checks the
# recorded gitlink out. So a bump is `git -C vscode checkout <tag>` **and**
# `git add vscode` before this script runs — provisioning against an unstaged
# bump would quietly rebuild the old version. The checked-out version is
# printed for exactly that reason.
step "VS Code submodule"
if [ "$FORCE" = 1 ] || [ ! -f "$VSCODE_DIR/package.json" ]; then
	git -C "$REPO_ROOT" submodule update --init --depth 1 -- vscode
fi
echo "checked out: $(git -C "$VSCODE_DIR" rev-parse --short HEAD) (VS Code $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$VSCODE_DIR/package.json" | head -1))"

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
# "Installed" is not one directory. `npm ci` in vscode/ installs the root tree
# and then runs a postinstall that installs a *nested* node_modules in every
# directory `build/npm/dirs.ts` names. Two of those groups are what the rest of
# this script and the packaging script consume: `build/` is where `npm run
# gulp`, `npm run compile` and `npm run electron` resolve their tooling, and
# `extensions/*/` is what `compile-extensions-build` compiles against.
#
# Those nested trees are 3.4 GB and are therefore not in CI's cache, which
# holds vscode/node_modules, vscode/out, vscode/.build and the toolchain. A
# cache hit restored a tree that passed the old single-directory check and
# could not build: the nightly died in packaging on `Cannot find package
# 'ternary-stream'`, a build/ dependency. So the check asks for the directories
# the consumers need and names the ones that are missing.
#
# The repair for a partial tree is VS Code's own postinstall on its own — the
# root install is already there, and the nested installs are minutes where a
# full `npm ci` is tens of them. Two things about invoking it:
#
#   * it short-circuits on a state file it keeps *inside* the cached root
#     node_modules, which a cache hit restores, so it has to be told the tree
#     is not up to date. VSCODE_FORCE_INSTALL is upstream's own flag for that.
#   * it is run as `node build/npm/postinstall.ts`, not `npm run postinstall`.
#     The script takes the npm subcommand to use from `$npm_command`, and npm
#     sets that to `run-script` for the script it is running — so through `npm
#     run` it obediently runs `npm run-script` in all 54 directories, prints
#     each one's list of available scripts, installs nothing, and exits 0.
vscode_dirs_without_node_modules() {
	(cd "$VSCODE_DIR" && node -e '
		const fs = require("fs"), path = require("path");
		import("./build/npm/dirs.ts").then(({ dirs }) => {
			for (const dir of dirs) {
				if (!/^(build|extensions)(\/|$)/.test(dir)) continue;
				if (fs.existsSync(path.join(dir, "package.json")) && !fs.existsSync(path.join(dir, "node_modules"))) {
					console.log(dir);
				}
			}
		});
	')
}

step "npm ci in vscode/"
if [ "$FORCE" = 1 ] || [ ! -d "$VSCODE_DIR/node_modules/electron" ]; then
	(cd "$VSCODE_DIR" && npm ci)
else
	INCOMPLETE="$(vscode_dirs_without_node_modules)"
	if [ -n "$INCOMPLETE" ]; then
		echo "vscode/node_modules is there, but these have none:"
		echo "$INCOMPLETE" | sed 's/^/  /'
		echo "running VS Code's own nested installs"
		(cd "$VSCODE_DIR" && VSCODE_FORCE_INSTALL=1 node build/npm/postinstall.ts)
	else
		echo "vscode/node_modules already installed"
	fi
fi

INCOMPLETE="$(vscode_dirs_without_node_modules)"
if [ -n "$INCOMPLETE" ]; then
	echo "the install left these directories without a node_modules:" >&2
	echo "$INCOMPLETE" | sed 's/^/  /' >&2
	exit 1
fi

# --- 3b. the patches DevHub cannot avoid ------------------------------------
# Applying them is scripts/apply-vscode-patches.sh, because the VS Code bump
# workflow needs the same step on its own to find out whether the patches still
# apply to a newer tag. What belongs here and not there is the stamp: it is the
# compile below that has to know what its source was.
step "patches/vscode"
# What `vscode/out` was built from: the submodule commit *and* the patches on
# top of it. Both belong in the stamp — a stamp over the patches alone survives
# a submodule bump unchanged, so the next non-`--force` run would find an `out/`
# that looks current and skip the compile, leaving DevHub running yesterday's
# VS Code against today's source.
SOURCE_STAMP="$VSCODE_DIR/.build/devhub-source.stamp"
SOURCE_STATE="$(
	git -C "$VSCODE_DIR" rev-parse HEAD
	cat "$REPO_ROOT"/patches/vscode/*.patch 2>/dev/null
	)"
SOURCE_STATE="$(printf '%s' "$SOURCE_STATE" | shasum | cut -d' ' -f1)"
"$REPO_ROOT/scripts/apply-vscode-patches.sh"

# --- 4. compile ------------------------------------------------------------
# Two trees come out of this step, and the stamp covers both.
#
#   out/              the module-by-module compile. `pnpm dev` runs on it:
#                     VSCODE_DEV is set, VS Code loads its source graph file by
#                     file, and a change is one `npm run compile` away.
#   out-vscode-min/   the bundled tree, one file per process. The packaged app
#                     runs on it, with VSCODE_DEV unset, because that is what
#                     makes it a built product rather than a checkout that
#                     happens to be zipped. See scripts/package-nightly.py.
#
# One stamp for both: a tree that agrees with the source and a tree beside it
# that does not is the state the stamp exists to make impossible, and "which of
# the two is stale" is not a question anybody should have to ask.
step "compile vscode/"
if [ "$FORCE" = 1 ] \
	|| [ ! -f "$VSCODE_DIR/out/vs/code/electron-main/main.js" ] \
	|| [ ! -f "$VSCODE_DIR/out-vscode-min/main.js" ] \
	|| [ "$(cat "$SOURCE_STAMP" 2>/dev/null)" != "$SOURCE_STATE" ]; then
	(cd "$VSCODE_DIR" && npm run compile)
	# Upstream's own CI path. It transpiles with esbuild rather than tsc, which
	# is both faster and the only one that completes here: the tsc path stops on
	# a declaration-portability error in upstream's own Copilot agent-host
	# source, which the dev compile never emits declarations for and so never
	# sees.
	(cd "$VSCODE_DIR" && npm run core-ci)
	mkdir -p "$(dirname "$SOURCE_STAMP")"
	printf '%s' "$SOURCE_STATE" > "$SOURCE_STAMP"
else
	echo "vscode/out and vscode/out-vscode-min already built from this commit and these patches"
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

# --- 5b. the same Electron, in a bundle that says DevHub -------------------
# macOS names an application from the bundle it is running in, not from
# anything the process says about itself: the application menu, the Dock tile,
# Mission Control and the window switcher all read the bundle's CFBundleName.
# The bundle above is VS Code's own, so a source run booted straight from it
# calls itself "Code - OSS" in every one of those places — `app.setName()` in
# apps/desktop/src/main/main.ts cannot reach any of them.
#
# So a source run boots a branded clone of it instead, the way the packaged app
# boots a branded copy. It is the same Electron either way, which is what the
# native modules in vscode/node_modules require; only the names differ, and
# they come from apps/desktop/product-overrides.json like every other name
# DevHub goes by. On APFS the clone is copy-on-write, so it costs no disk.
step "DevHub-branded Electron"
DEVHUB_ELECTRON_DIR="$VSCODE_DIR/.build/devhub-electron"
if [ "$(uname -s)" = "Darwin" ]; then
	if [ "$FORCE" = 1 ]; then
		rm -rf "$DEVHUB_ELECTRON_DIR"
	fi
	python3 "$REPO_ROOT/scripts/darwin_bundle.py" "$DEVHUB_ELECTRON_DIR"
else
	# Only macOS reads a name out of a bundle; elsewhere the binary is the app.
	echo "not macOS — a source run boots VS Code's Electron directly"
fi

# --- 6. the built-in extension set DevHub starts with ---------------------
# DevHub's own integration ships as a built-in so that its workbench defaults
# (contributes.configurationDefaults) are in effect and cannot be uninstalled.
# See the script for why the whole set has to be staged.
step "built-in extensions"
(cd "$REPO_ROOT/extensions/devhub-bridge" && node scripts/build.mjs)
"$REPO_ROOT/scripts/stage-builtin-extensions.sh"

printf '\nprovisioned.\n'
