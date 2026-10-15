#!/bin/sh
# The Linux half of scripts/build_reh.py: VS Code's own Linux build of its
# remote extension host, run inside a container, on a copy of the pinned VS
# Code that is not the developer's checkout.
#
# Every step is the step upstream runs on its Linux agents, in upstream's order
# (vscode/build/azure-pipelines/linux/steps/product-build-linux-setup.yml and
# -compile.yml, and alpine/product-build-alpine.yml for the musl servers):
#
#   prepare       per architecture, in the builder image (linux/amd64, bash):
#                   the tree      the pinned commit, unpacked from
#                                 /xfer/vscode-src.tar into a git repository of
#                                 its own (postinstall runs `git config`, and
#                                 build/lib/date.ts reads the commit date)
#                   the patches   scripts/apply-vscode-patches.sh --into, and
#                                 DevHub's product.json merged in
#                   npm ci        `npm ci` in build/, then with
#                                 npm_config_arch/VSCODE_ARCH set:
#                                 `source build/azure-pipelines/linux/setup-env.sh`
#                                 (VS Code's glibc 2.28 sysroots, its compilers
#                                 for the client natives and VSCODE_REMOTE_* for
#                                 remote/), `node build/npm/preinstall.ts`,
#                                 `npm ci` (five tries, as upstream)
#                   compile       built-in extensions, electron types,
#                                 the server's part of `gulp core-ci`
#                                 (`core_ci_server`), then
#                                 compile-copilot-extension-build and the SDK
#                                 staging the REH package task needs (upstream
#                                 downloads a Copilot VSIX instead)
#   musl-remote   per musl target, in node:<version>-alpine of the target's
#                 platform (sh): remote/'s `npm i -g node-gyp-build && npm ci`,
#                 as build/npm/postinstall.ts runs it in upstream's Alpine
#                 container (VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME), and the
#                 musl `node` put where the gulp task looks for it
#   package       per target, in the builder image: `npm run gulp
#                 vscode-reh-<platform>-<arch>-min-ci`, and the tree tarred to
#                 /xfer/<target>.tar for the host's own post-steps
#   verify-glibc  in the builder image, on a finished glibc server mounted at
#                 /server: upstream's verify-glibc-requirements.sh with the
#                 sysroot the tree downloaded
#
# Each expensive step is skipped when its stamp under /build/.devhub says its
# inputs have not changed (see `prepare`). /build is a Docker volume per
# architecture, so a rerun picks up where the last one stopped.
#
# POSIX sh: `musl-remote` runs in an Alpine image, which has no bash. Only
# setup-env.sh, which is upstream's and bash, is sourced under bash.
#
# DEVHUB_REH_LIB=1 defines the functions and returns without running anything
# (scripts/build_reh_test.py exercises them that way).
set -eu

B="${DEVHUB_REH_BUILD:-/build}"
X="${DEVHUB_REH_XFER:-/xfer}"
D="${DEVHUB_REH_DEVHUB:-/devhub}"
V="$B/vscode"
S="$B/.devhub"
R="$V/remote"
SYSROOT_DIR_NAME="glibc-2.28-gcc-8.5.0"

step() { printf '\n==> [%s] %s\n' "${TARGET:-${ARCH:-reh}}" "$1"; }
die() { printf 'reh_in_container.sh: %s\n' "$1" >&2; exit 1; }
need() {
	for name in "$@"; do
		eval "value=\${$name:-}"
		[ -n "$value" ] || die "$name is not set"
	done
}
stamp() { cat "$S/$1.stamp" 2>/dev/null || true; }

# Memory. Measured natively (Linux x64, 4 CPUs), the heaviest steps peak at
# about 3 GB each: the extension builds, the Copilot compile (its esbuild alone
# is 2 GB), the server bundle and the package task (gulp itself 2 GB). What
# kills a smaller machine is how upstream runs them, sized for its agents:
#
# - `bundle-non-native-extensions-build` and `compile-extension-media-build`
#   start every extension's `node esbuild.mts` and tsgo type check at once,
#   some 70 Node processes and as many esbuild and tsgo programs. Natively
#   they come and go in seconds; amd64 under Rosetta or QEMU, each carries
#   the emulator's own memory and they all live for minutes, which is where
#   a Mac's Docker was killed. scripts/reh_build_gate.cjs, loaded into gulp,
#   runs at most DEVHUB_BUILD_JOBS of them at a time (2 unless set).
# - `npm run gulp` lets gulp's heap grow to 8 GB, all of an 8 GB machine.
#   Gulp needs about 2 GB (the package task, measured); it runs with
#   DEVHUB_GULP_HEAP_MB (4096) instead.
# - The steps run one after another, never side by side.
#
# A step the kernel kills for memory says so and exits 137 (see `heavy`),
# which scripts/build_reh.py turns into how much memory Docker needs.
JOBS="${DEVHUB_BUILD_JOBS:-2}"
GULP_HEAP_MB="${DEVHUB_GULP_HEAP_MB:-4096}"
GATE="$S/gate"

# run_gulp ARGS: `npm run gulp ARGS` as package.json's "gulp" script runs
# it, with the heap above and the gate (scripts/build_reh_test.py holds the
# two to each other).
run_gulp() {
	DEVHUB_BUILD_JOBS="$JOBS" DEVHUB_BUILD_GATE_DIR="$GATE" \
		node --experimental-strip-types --max-old-space-size="$GULP_HEAP_MB" \
		--require "$D/scripts/reh_build_gate.cjs" ./node_modules/gulp/bin/gulp.js "$@"
}

# heavy WHAT CMD...: run a step that can run out of memory. Killed — itself
# (exit 137) or a child the gate saw SIGKILLed — it says so and exits 137;
# any other failure exits with its own status.
heavy() {
	what="$1"
	shift
	rm -f "$GATE/killed"
	if "$@"; then return 0; else rc=$?; fi
	if [ "$rc" -eq 137 ] || [ -s "$GATE/killed" ]; then
		[ ! -s "$GATE/killed" ] || sed 's/^/  killed: /' "$GATE/killed" >&2
		printf 'reh_in_container.sh: %s was killed, out of memory (exit 137)\n' "$what" >&2
		exit 137
	fi
	exit "$rc"
}

# Upstream: `for i in {1..5}; do npm ci && break; ... done`. Each failure
# shows the end of npm's own debug log, so a log that ends in "failed 5 times"
# also says why (a native build's compiler error, a download refused).
npm_ci() {
	i=1
	while ! npm ci; do
		npm_failure_log "$i"
		[ "$i" -lt 5 ] || die "npm ci failed 5 times in $(pwd); the cause is in npm's log above"
		echo "npm ci failed $i, trying again..."
		i=$((i + 1))
	done
}

npm_failure_log() {
	logs="${npm_config_cache:-$HOME/.npm}/_logs"
	log="$(ls -t "$logs"/*-debug-*.log 2>/dev/null | head -n 1 || true)"
	if [ -z "$log" ]; then
		echo "npm ci failed (try $1) in $(pwd); no npm debug log in $logs"
		return 0
	fi
	echo "---- npm ci failed (try $1) in $(pwd); npm's errors, from $log:"
	if grep -q '^[0-9]* error ' "$log"; then
		grep '^[0-9]* error ' "$log" | tail -n 80
	else
		grep -Ev '^[0-9]+ (silly|verbose|timing|http) ' "$log" | tail -n 60
	fi
	echo "---- end of $log"
}

# What `npm ci` depends on: every manifest, lock file and .npmrc as patched,
# .nvmrc, the architecture and the builder image. Not the patches as such —
# a patch that leaves the manifests alone reuses node_modules.
deps_key() {
	{
		echo "arch $ARCH"
		echo "builder $BUILDER_IMAGE"
		git -C "$V" ls-files -z -- '*package.json' '*package-lock.json' '*.npmrc' '.nvmrc' \
			| (cd "$V" && xargs -0 sha256sum)
	} | sha256sum | cut -d' ' -f1
}

# remote/node_modules exists twice once a musl server has been built: the glibc
# one `npm ci` installed and the musl one `musl-remote` installed. The one not
# in use waits in $S/remote-<libc>; $S/remote.libc says which is in place.
use_remote() {
	have="$(cat "$S/remote.libc" 2>/dev/null || echo glibc)"
	[ "$have" = "$1" ] && return 0
	rm -rf "$S/remote-$have"
	if [ -d "$R/node_modules" ]; then mv "$R/node_modules" "$S/remote-$have"; fi
	if [ -d "$S/remote-$1" ]; then mv "$S/remote-$1" "$R/node_modules"; fi
	echo "$1" > "$S/remote.libc"
}

# The REH package task's last step walks into the server tree's
# extensions/copilot/node_modules/@github/copilot (its sdk/ and its
# package.json version) and throws without them. compile-copilot-extension-build
# does not put them in .build — build/.moduleignore strips @github/copilot/**
# from every production dependency stream, and upstream ships the extension as
# a VSIX instead — so the installed package is copied in, symlinks resolved.
has_copilot_sdk() {
	[ -n "$(find -L "$1/sdk" -type f 2>/dev/null | head -n 1)" ] || return 1
	node -e 'const v = require(process.argv[1] + "/package.json").version; process.exit(typeof v === "string" && v ? 0 : 1)' "$1" 2>/dev/null
}

stage_copilot_sdk() {
	installed="$V/extensions/copilot/node_modules/@github/copilot"
	staged="$V/.build/extensions/copilot/node_modules/@github/copilot"
	has_copilot_sdk "$staged" && return 0
	has_copilot_sdk "$installed" || die "no built-in Copilot SDK files or no package.json version at $installed: \`npm ci\` in extensions/copilot materialises them, and every REH package task fails without them"
	rm -rf "$staged"
	mkdir -p "$(dirname "$staged")"
	cp -RL "$installed" "$staged"
	has_copilot_sdk "$staged" || die "copying $installed to $staged left no SDK files"
	echo "staged the built-in Copilot package into $staged"
}

# product.builtInExtensions (js-debug, its companion, the profile table), as
# the client gets them: build/lib/builtInExtensions.ts downloads from the
# product's gallery when it names one and from the GitHub releases pinned by
# version and sha256 otherwise. DevHub's product.json names Open VSX, which is
# for the user's extensions, not for these — upstream's gallery is the
# Marketplace, and DevHub's own checkout (provision-vscode.sh) has no gallery
# and takes the GitHub releases. So the download sees product.json without
# the gallery, and product.json is put back whatever happens. The package task
# then finds them up to date in .build/builtInExtensions and downloads nothing.
builtin_extensions() {
	cp product.json "$S/product.json"
	node -e '
		const fs = require("fs");
		const product = JSON.parse(fs.readFileSync("product.json", "utf8"));
		delete product.extensionsGallery;
		fs.writeFileSync("product.json", JSON.stringify(product, null, "\t") + "\n");
	'
	if VSCODE_EXTENSION_TARGET="linux-$ARCH" node build/lib/builtInExtensions.ts; then ok=1; else ok=0; fi
	mv "$S/product.json" product.json
	[ "$ok" = 1 ] || die "downloading product.builtInExtensions failed"
}

# The part of upstream's `gulp core-ci` (build/gulpfile.vscode.ts) a server is
# made of, run the way core-ci runs it. core-ci bundles the desktop workbench,
# the server and the web server in parallel, and the three peak past 14 GB —
# more than the builder is given, so the desktop bundle, which no server
# carries, got the whole build killed for memory. What the package task reads
# is core-ci's extension builds (.build/extensions, with the Marketplace
# built-ins) and out-vscode-reh-min; what is left out produces nothing it reads:
# the desktop and web bundles, the tsgo type check and the per-module
# transpile into out-build (scripts/provision-vscode.sh's fast bundle leaves
# out the same, for the same reason). The bundle is the command core-ci's
# `esbuild-vscode-reh-min` runs (runEsbuildBundle in build/lib/esbuild.ts),
# after `writeISODate('out-build')`'s file.
core_ci_server() {
	step "core-ci for the server: extensions, codicons, out-vscode-reh-min"
	heavy "the extension builds" run_gulp --series check-api-proposal-names copy-codicons \
		compile-non-native-extensions-build compile-extension-media-build
	mkdir -p out-build
	git log -1 --format=%cI HEAD > out-build/date
	heavy "the server bundle" node build/next/index.ts bundle --out out-vscode-reh-min --target server \
		--minify --mangle-privates --nls \
		--source-map-base-url "https://main.vscode-cdn.net/sourcemaps/$COMMIT/core"
	[ -f out-vscode-reh-min/server-main.js ] || die "the server bundle wrote no out-vscode-reh-min/server-main.js"
}

prepare() {
	need COMMIT COMMIT_DATE SOURCE_KEY ARCH BUILDER_IMAGE
	mkdir -p "$S"

	# 1. The tree. A new commit is a new tree: everything under $B goes.
	if [ "$(stamp tree)" != "$COMMIT" ] || [ ! -d "$V/.git" ]; then
		step "VS Code $COMMIT into $V"
		[ -f "$X/vscode-src.tar" ] || die "no $X/vscode-src.tar"
		rm -rf "$V" "$S" "$B"/vscode-reh-*
		mkdir -p "$V" "$S"
		tar -xf "$X/vscode-src.tar" -C "$V"
		git -C "$V" init -q
		git -C "$V" add -A -f
		GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" \
			git -C "$V" -c user.name=DevHub -c user.email=devhub@localhost commit -q -m "VS Code $COMMIT"
		echo "$COMMIT" > "$S/tree.stamp"
	fi
	cd "$V"

	# 2. DevHub's patches and product.json, on a reset tree. Ignored files —
	#    node_modules, .build, out-* — survive the reset.
	if [ "$(stamp source)" != "$SOURCE_KEY" ]; then
		step "DevHub patches and product.json"
		rm -f "$S/source.stamp" "$S/compile.stamp"
		git checkout -q -- .
		git clean -fdq
		bash "$D/scripts/apply-vscode-patches.sh" --into "$V"
		node -e '
			const fs = require("fs");
			const product = JSON.parse(fs.readFileSync("product.json", "utf8"));
			Object.assign(product, JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
			fs.writeFileSync("product.json", JSON.stringify(product, null, "\t") + "\n");
		' "$X/product-overrides.json"
		echo "$SOURCE_KEY" > "$S/source.stamp"
	fi

	# 3. Dependencies, as product-build-linux-setup.yml installs them.
	deps="$(deps_key)"
	if [ "$(stamp deps)" != "$deps" ]; then
		step "npm ci for linux-$ARCH (setup-env.sh, preinstall.ts, npm ci)"
		rm -f "$S/deps.stamp" "$S/compile.stamp" "$S/remote-musl.stamp"
		rm -rf "$S/remote-glibc" "$S/remote-musl"
		if [ "$(cat "$S/remote.libc" 2>/dev/null || echo glibc)" != glibc ]; then rm -rf "$R/node_modules"; fi
		echo glibc > "$S/remote.libc"
		(cd build && npm_ci)
		(
			export npm_config_arch="$ARCH" VSCODE_ARCH="$ARCH"
			export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
			export ONNXRUNTIME_NODE_INSTALL=skip FOUNDRY_LOCAL_SKIP_INSTALL=1
			# setup-env.sh writes $HOME/.gyp/include.gypi, which every later
			# node-gyp build of that user reads. Natively that is the
			# developer's own home, so the tree gets one of its own; npm's
			# cache and configuration and git's stay the user's.
			home="$HOME"
			export npm_config_cache="${npm_config_cache:-$home/.npm}"
			export npm_config_userconfig="${npm_config_userconfig:-$home/.npmrc}"
			export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-$home/.gitconfig}"
			export HOME="$S/home"
			mkdir -p "$HOME"
			set +u
			. ./build/azure-pipelines/linux/setup-env.sh
			set -u
			node build/npm/preinstall.ts
			npm_ci
		)
		echo "$deps" > "$S/deps.stamp"
	fi

	# 4. The compile, as product-build-linux-compile.yml runs it.
	compiled="$SOURCE_KEY $deps"
	if [ "$(stamp compile)" != "$compiled" ]; then
		rm -f "$S/compile.stamp"
		use_remote glibc
		export VSCODE_ARCH="$ARCH" BUILD_SOURCEVERSION="$COMMIT"
		step "built-in extensions"
		builtin_extensions
		node build/npm/electronTypes.ts
		core_ci_server
		# VSCODE_QUALITY: the compile refuses to guess a channel with CI set.
		step "gulp compile-copilot-extension-build"
		(export VSCODE_QUALITY=stable && heavy "the Copilot compile" run_gulp compile-copilot-extension-build)
		stage_copilot_sdk
		echo "$compiled" > "$S/compile.stamp"
	fi
}

musl_remote() {
	need ARCH MUSL_IMAGE NODE_VERSION GULP_PLATFORM GULP_ARCH
	[ -n "$(stamp deps)" ] || die "no dependencies installed in $B: prepare first"
	want="$(stamp deps) $MUSL_IMAGE"
	use_remote musl
	if [ "$(stamp remote-musl)" != "$want" ] || [ ! -d "$R/node_modules" ]; then
		step "remote/ for musl in $MUSL_IMAGE"
		rm -f "$S/remote-musl.stamp"
		rm -rf "$R/node_modules"
		(cd "$R" && npm i -g node-gyp-build && npm_ci)
		# build/npm/postinstall.ts removeParcelWatcherPrebuild
		rm -rf "$R"/node_modules/@parcel/watcher-*
		echo "$want" > "$S/remote-musl.stamp"
	fi
	# gulpfile.reh.ts's node-<platform>-<arch> task downloads only when this
	# directory is absent; upstream fills it from its own musl Node feed, and
	# without one runs `docker run node:<v>-alpine`, which a container cannot.
	nodedir="$V/.build/node/v$NODE_VERSION/$GULP_PLATFORM-$GULP_ARCH"
	rm -rf "$nodedir"
	mkdir -p "$nodedir"
	cp "$(command -v node)" "$nodedir/node"
	chmod 755 "$nodedir/node"
	[ "$("$nodedir/node" --version)" = "v$NODE_VERSION" ] || die "$MUSL_IMAGE's node is not v$NODE_VERSION"
}

package() {
	need TARGET ARCH LIBC GULP_PLATFORM GULP_ARCH COMMIT
	[ -n "$(stamp compile)" ] || die "$V is not compiled: prepare first"
	cd "$V"
	use_remote "$LIBC"
	[ -d "$R/node_modules" ] || die "no $LIBC remote/node_modules in $V (scripts/build_reh.py --reset-work rebuilds the tree)"
	if [ "$LIBC" = musl ] && [ -z "$(stamp remote-musl)" ]; then die "remote/ is not installed for musl: musl-remote first"; fi
	out="vscode-reh-$GULP_PLATFORM-$GULP_ARCH"
	step "gulp $out-min-ci"
	(export VSCODE_ARCH="$ARCH" BUILD_SOURCEVERSION="$COMMIT" && heavy "$out-min-ci" run_gulp "$out-min-ci")
	[ -d "$B/$out" ] || die "$out-min-ci produced no $B/$out"
	rm -f "$X/$TARGET.tar" "$X/$TARGET.tar.partial"
	tar -C "$B" -cf "$X/$TARGET.tar.partial" "$out"
	mv "$X/$TARGET.tar.partial" "$X/$TARGET.tar"
}

verify_glibc() {
	need ARCH EXPECTED_GLIBC_VERSION EXPECTED_GLIBCXX_VERSION
	cd "$V"
	SEARCH_PATH="${SERVER:-/server}" VSCODE_SYSROOT_DIR="$V/.build/sysroots/$SYSROOT_DIR_NAME" \
		VSCODE_ARCH="$ARCH" npm_config_arch="$ARCH" \
		bash ./build/azure-pipelines/linux/verify-glibc-requirements.sh
}

if [ "${DEVHUB_REH_LIB:-}" = 1 ]; then
	return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
	prepare) prepare ;;
	musl-remote) musl_remote ;;
	package) package ;;
	verify-glibc) verify_glibc ;;
	*) die "usage: reh_in_container.sh prepare|musl-remote|package|verify-glibc" ;;
esac
