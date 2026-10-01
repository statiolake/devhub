#!/usr/bin/env bash
# Prepare the pinned VS Code submodule so the DevHub desktop app can run against
# it: check out the submodule, put the Node version VS Code's build requires in a
# gitignored toolchain dir, install VS Code's own npm dependencies and compile.
#
# VS Code is consumed, never edited. Everything this script produces lives inside
# vscode/ (npm-managed, gitignored by the submodule itself) or vscode-toolchain/.
#
# Idempotent: each step is skipped when its output already exists.
#   --force       redo every step regardless.
#   --for WHAT    which VS Code build outputs to produce (default: all):
#                   dev    vscode/out — what `pnpm dev` runs on
#                   app    vscode/out-vscode-min (+ out-build) — what
#                          scripts/package-nightly.py packages (`pnpm build`)
#                   all    both
#                   deps   neither: dependencies, patches, Electron and the
#                          built-in extensions only (scripts/build_reh.py runs
#                          its own `core-ci`)
#
# DEVHUB_FAST_VSCODE_BUNDLE decides how out-vscode-min is made; see step 4b.
# It defaults to 1 on a developer's machine and to 0 when CI is set.
set -euo pipefail

FORCE=0
OUTPUTS=all
usage() { echo "usage: $(basename "$0") [--force] [--for dev|app|all|deps]" >&2; exit 2; }
while [ $# -gt 0 ]; do
	case "$1" in
		--force) FORCE=1 ;;
		--for)
			[ $# -ge 2 ] || usage
			OUTPUTS="$2"
			shift
			;;
		--for=*) OUTPUTS="${1#--for=}" ;;
		*) usage ;;
	esac
	shift
done
WANT_OUT=0
WANT_BUNDLE=0
case "$OUTPUTS" in
	dev) WANT_OUT=1 ;;
	app) WANT_BUNDLE=1 ;;
	all) WANT_OUT=1; WANT_BUNDLE=1 ;;
	deps) ;;
	*) usage ;;
esac
if [ -n "${CI:-}" ]; then
	FAST_BUNDLE="${DEVHUB_FAST_VSCODE_BUNDLE:-0}"
else
	FAST_BUNDLE="${DEVHUB_FAST_VSCODE_BUNDLE:-1}"
fi
case "$FAST_BUNDLE" in
	0 | 1) ;;
	*) echo "DEVHUB_FAST_VSCODE_BUNDLE must be 0 or 1, not '$FAST_BUNDLE'" >&2; exit 2 ;;
esac

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

# Which submodule commit the tree below was installed from, and the whole of
# what "already installed" means here.
#
# It replaces a check for one package being present, which asked the wrong
# question twice over. A bump rewrites vscode/package.json and every nested
# package.json with it, and no single directory's existence reflects that: at
# 1.131.0 the tree had a package the compile needed and 1.136.1 added another,
# so the old check happily passed over yesterday's dependencies and the run died
# tens of minutes later, in the compile, on `Cannot find package
# '@vscode/gulp-vinyl-zip'` — a message naming neither the bump nor the install.
# The sentinel package was `electron`, which 1.136.1 dropped from its
# devDependencies outright, so the check had also stopped ever being satisfied:
# every run reinstalled from scratch.
#
# The submodule commit is the exact key, because package.json is tracked content
# of the submodule and patches/vscode never touches a manifest. The stamp lives
# inside node_modules so that deleting the tree takes the claim about it along,
# and it is written only past the completeness check below — so a stamp that
# matches means installed, complete, and from this commit, and nothing else
# needs asking.
INSTALL_STAMP="$VSCODE_DIR/node_modules/.devhub-install.stamp"
INSTALL_STATE="$(git -C "$VSCODE_DIR" rev-parse HEAD)"

step "npm ci in vscode/"
if [ "$FORCE" = 1 ] || [ "$(cat "$INSTALL_STAMP" 2>/dev/null)" != "$INSTALL_STATE" ]; then
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
# Written only here, past every check above: the stamp is a claim that the tree
# is complete for this commit, so it must not survive a run that found it was
# not.
printf '%s' "$INSTALL_STATE" > "$INSTALL_STAMP"

# --- 3b. the patches DevHub cannot avoid ------------------------------------
# Applying them is scripts/apply-vscode-patches.sh, because the VS Code bump
# workflow needs the same step on its own to find out whether the patches still
# apply to a newer tag. What belongs here and not there is the stamp: it is the
# compile below that has to know what its source was.
step "patches/vscode"
# What the trees below were built from: the submodule commit *and* the patches
# on top of it. Both belong in the stamps — a stamp over the patches alone
# survives a submodule bump unchanged, so the next non-`--force` run would find
# an `out/` that looks current and skip the compile, leaving DevHub running
# yesterday's VS Code against today's source.
SOURCE_STATE="$(
	git -C "$VSCODE_DIR" rev-parse HEAD
	cat "$REPO_ROOT"/patches/vscode/*.patch 2>/dev/null
	)"
SOURCE_STATE="$(printf '%s' "$SOURCE_STATE" | shasum | cut -d' ' -f1)"
"$REPO_ROOT/scripts/apply-vscode-patches.sh"

# --- 4. compile ------------------------------------------------------------
# Two trees can come out of this step, each under its own stamp, because the
# two consumers want different ones and each should pay only for its own:
#
#   out/              the module-by-module compile (`npm run compile`, ~90 s,
#                     plus the extensions' and Copilot's out/). `pnpm dev` runs
#                     on it: VSCODE_DEV is set, VS Code loads its source graph
#                     file by file. `--for dev`.
#   out-vscode-min/   the bundled tree, one file per process. The packaged app
#                     runs on it, with VSCODE_DEV unset, because that is what
#                     makes it a built product rather than a checkout that
#                     happens to be zipped. See scripts/package-nightly.py.
#                     `--for app`.
#
# Both stamps start with SOURCE_STATE, so a bump or a patch edit rebuilds
# exactly the trees that were asked for. A tree that was not asked for is left
# alone with its stamp still saying what it was built from, so nothing mistakes
# it for current. scripts/package-nightly.py reads both.
COMPILE_STAMP="$VSCODE_DIR/.build/devhub-compile.stamp"
BUNDLE_STAMP="$VSCODE_DIR/.build/devhub-bundle.stamp"
mkdir -p "$VSCODE_DIR/.build"
# The single stamp that once covered both trees. Nothing reads it any more.
rm -f "$VSCODE_DIR/.build/devhub-source.stamp"

step "compile vscode/ (out/)"
if [ "$WANT_OUT" = 0 ]; then
	echo "skipped: --for $OUTPUTS does not need vscode/out"
elif [ "$FORCE" = 1 ] \
	|| [ ! -f "$VSCODE_DIR/out/vs/code/electron-main/main.js" ] \
	|| [ "$(cat "$COMPILE_STAMP" 2>/dev/null)" != "$SOURCE_STATE" ]; then
	rm -f "$COMPILE_STAMP"
	(cd "$VSCODE_DIR" && npm run compile)
	printf '%s' "$SOURCE_STATE" > "$COMPILE_STAMP"
else
	echo "vscode/out already compiled from this commit and these patches"
fi

# --- 4b. bundle ------------------------------------------------------------
# Two ways to make out-vscode-min. The stamp records which one did
# ("<SOURCE_STATE> full" or "<SOURCE_STATE> fast"), so switching rebuilds, and
# scripts/package-nightly.py refuses a fast bundle when CI is set.
#
#   full — DEVHUB_FAST_VSCODE_BUNDLE=0, the default when CI is set, so what the
#     nightly ships: `npm run core-ci`, upstream's own CI path. It transpiles
#     with esbuild rather than tsc, which is both faster and the only one that
#     completes here: the tsc path stops on a declaration-portability error in
#     upstream's own Copilot agent-host source. Besides the desktop bundle it
#     type-checks with tsgo, bundles the built-in extensions, and bundles
#     out-vscode-reh-min and out-vscode-reh-web-min in parallel (together the
#     three peak well past 16 GB).
#
#   fast — DEVHUB_FAST_VSCODE_BUNDLE=1, the default locally: only the steps of
#     `core-ci` the packaged app consumes, run the way core-ci runs them
#     (runEsbuildBundle in vscode/build/lib/esbuild.ts):
#       * copy-codicons — the font the bundle copies in as a resource;
#       * the esbuild transpile into out-build — the per-module tree
#         package-nightly.py bundles DevHub's main process against when out/
#         was not compiled (`--for app` does not compile it), ~10 s against
#         `npm run compile`'s ~90 s;
#       * the desktop bundle, minified and with NLS, like core-ci's.
#     Left out: the two server bundles (scripts/build_reh.py runs its own
#     `core-ci` for them), the extension bundling (package-nightly.py runs
#     `compile-extensions-build`, which cleans .build/extensions first, so
#     core-ci's copy was discarded anyway), the tsgo type check, the CDN
#     source-map URL, and `--mangle-privates`. That flag rewrites native
#     `#private` fields into short `$a` properties, for V8 speed and size.
#     Without it the bundle keeps the fields exactly as the source declares
#     them — the semantics `pnpm dev` runs on — and nothing in VS Code or
#     DevHub reads a mangled name. NLS stays: it is most of the bundle's time,
#     but without it a language pack has no message table to apply to.
if [ "$FAST_BUNDLE" = 1 ]; then BUNDLE_MODE=fast; else BUNDLE_MODE=full; fi
BUNDLE_STATE="$SOURCE_STATE $BUNDLE_MODE"

step "bundle vscode/ (out-vscode-min, $BUNDLE_MODE)"
if [ "$WANT_BUNDLE" = 0 ]; then
	echo "skipped: --for $OUTPUTS does not need vscode/out-vscode-min"
elif [ "$FORCE" = 1 ] \
	|| [ ! -f "$VSCODE_DIR/out-vscode-min/main.js" ] \
	|| [ ! -f "$VSCODE_DIR/out-build/vs/code/electron-main/main.js" ] \
	|| [ "$(cat "$BUNDLE_STAMP" 2>/dev/null)" != "$BUNDLE_STATE" ]; then
	rm -f "$BUNDLE_STAMP"
	if [ "$BUNDLE_MODE" = full ]; then
		(cd "$VSCODE_DIR" && npm run core-ci)
	else
		(
			cd "$VSCODE_DIR"
			npm run gulp copy-codicons
			node build/next/index.ts transpile --out out-build
			node build/next/index.ts bundle --out out-vscode-min --target desktop --minify --nls
		)
	fi
	printf '%s' "$BUNDLE_STATE" > "$BUNDLE_STAMP"
else
	echo "vscode/out-vscode-min already bundled ($BUNDLE_MODE) from this commit and these patches"
fi

# --- 5. the Electron our main process runs in ------------------------------
# Our main process runs inside VS Code's own Electron: the native modules in
# vscode/node_modules are built for exactly this binary. npm ci does not fetch
# it; VS Code's `electron` script does.
step "Electron runtime"
ELECTRON_APP="$VSCODE_DIR/.build/electron"
# Which Electron this VS Code is: `vscode/.npmrc` states it as the `target` npm
# built every native module in vscode/node_modules against, and `npm run
# electron` fetches that same one. So the version already on disk has to be
# compared against it, not merely be present — a bump raises the target, npm ci
# rebuilds node-pty and friends for the new one, and a `.build/electron` left
# over from the previous tag would go on running the old binary underneath them.
# Nothing about that says "wrong": the app starts, and the native modules it
# needs fail one by one, which is what a terminal that will not open looks like.
ELECTRON_TARGET="$(sed -n 's/^target="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$VSCODE_DIR/.npmrc")"
if [ -z "$ELECTRON_TARGET" ]; then
	echo "no target= in $VSCODE_DIR/.npmrc — cannot tell which Electron this VS Code wants" >&2
	exit 1
fi
if [ "$FORCE" = 1 ] \
	|| [ ! -d "$ELECTRON_APP" ] \
	|| [ "$(cat "$ELECTRON_APP/version" 2>/dev/null)" != "$ELECTRON_TARGET" ]; then
	(cd "$VSCODE_DIR" && npm run electron)
	# The branded clone below is a copy of this bundle, so it is now a copy of
	# the wrong one. Take it away and let the step rebuild it.
	rm -rf "$VSCODE_DIR/.build/devhub-electron"
fi
if [ "$(cat "$ELECTRON_APP/version" 2>/dev/null)" != "$ELECTRON_TARGET" ]; then
	echo "$ELECTRON_APP is Electron $(cat "$ELECTRON_APP/version" 2>/dev/null || echo unknown), but this VS Code is built for $ELECTRON_TARGET" >&2
	exit 1
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
#
# VS Code's own set is in two halves. The submodule carries most of it, and
# `product.builtInExtensions` names the rest — js-debug, its companion, and the
# JS profile table — which upstream downloads at build time, pinned to a version
# and a sha256. `npm run download-builtin-extensions` is that mechanism; it
# checks each extension's version on disk first, so a run that has them costs
# nothing. Without this DevHub has no debug adapter for `node`, `node-terminal`
# or `extensionHost`, which is to say F5 does nothing at all, on a JavaScript
# project and on an extension repo alike.
step "built-in extensions"
(cd "$VSCODE_DIR" && npm run download-builtin-extensions)
# DevHub's own two extensions are built here for the same reason the bridge
# always was: the staging script below refuses a set with either missing.
(cd "$REPO_ROOT/extensions/devhub-bridge" && node scripts/build.mjs)
(cd "$REPO_ROOT/extensions/devhub-remote" && node scripts/build.mjs)
"$REPO_ROOT/scripts/stage-builtin-extensions.sh"

printf '\nprovisioned.\n'
