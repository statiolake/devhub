#!/usr/bin/env python3
"""Assemble a runnable, unsigned DevHub.app for macOS Apple Silicon.

DevHub is built the way VS Code is built, and this is the one place the two
layouts are written down side by side. Everything that differs between a
`pnpm dev` run and the app this script produces follows from one flag.

    dev (apps/desktop/scripts/dev.sh)   packaged (this script)
    ---------------------------------   ----------------------------------
    VSCODE_DEV=1                        unset
    vscode/out/, module by module       vscode/out-vscode-min/, one bundle
                                        per process
    apps/desktop/out/main/main.js       the same, esbuild-bundled into
    imports 94 deep module paths        code-oss-dev/out/main.js
    product.json + product.overrides    product.json alone, written by
    merged at runtime by bootstrap-     write_product_json
    meta.ts (it reads VSCODE_DEV)
    isBuilt false                       isBuilt true
    named "DevHub Dev", per upstream    named "DevHub"

The last line is the reason the rest exists. Upstream renames the product when
`VSCODE_DEV` is set, on the reasoning that only a developer's checkout runs out
of sources — and that reasoning is right. What was wrong was DevHub shipping a
checkout: the packaged app set `VSCODE_DEV` itself so VS Code could find its
modules, and inherited a name that was then true of the nightly too.

The obstacle to bundling was never the pipeline. It was that DevHub's main
process imports deep module paths (`code-oss-dev/out/vs/platform/.../windows.js`)
which a bundled tree does not have. But upstream's `src/main.ts` is a bundle
entry point for exactly the same reason, and DevHub's `main.ts` is that file's
replacement — so it is bundled the same way and put in the same place. See
`bundle_main_process`.

The layout inside the bundle, and why:

    DevHub.app/Contents/
      MacOS/DevHub                  VS Code's own Electron, renamed
      Frameworks/DevHub Helper*.app renamed with it — Electron finds its child
                                    processes by the main bundle's name, so the
                                    two names cannot drift apart
      Resources/DevHub.icns         rendered from assets/icon-master.svg, and
                                    installed by the same rename that gives the
                                    bundle its name — a source run's bundle gets
                                    it from there too
      Resources/app/                what Electron loads
        package.json                "main" -> devhub-main.js
        devhub-main.js              generated entry: the environment and the
                                    default directories dev.sh sets, set here
                                    instead, because a double-clicked app gets
                                    neither a shell nor arguments
        out/  dist/                 apps/desktop, minus its tests
        node_modules/
          minimist/                 the one real dependency of the main process
          code-oss-dev/             the submodule, materialised
            out/                    the patched dev compile, minus tests and
                                    minus inline source maps
            product.json            patched to say DevHub
            extensions/             the built-in set, production-bundled by
                                    VS Code's own `compile-extensions-build`,
                                    plus DevHub's bridge. This is
                                    `appRoot/extensions`, which is exactly
                                    where VS Code looks for built-ins, so the
                                    packaged app needs no `--builtin-
                                    extensions-dir` the way dev.sh does
            node_modules.asar       VS Code's *production* dependency closure,
                                    copied from the tree npm already built for
                                    this Electron, then collapsed into one
                                    archive
            node_modules.asar.unpacked
                                    the part of that closure that has to stay
                                    real files: native addons, spawned
                                    executables, `.wasm`
            node_modules/           what is left out of the archive entirely —
                                    see pack_node_modules_asar.mjs

Nothing here is a symlink: a link into the developer's checkout would leave the
zip working only on the machine that made it.

`code-oss-dev/node_modules` is an archive, the same one upstream ships and by
the same rules: `node_modules.asar` for what can be read out of an archive, and
`node_modules.asar.unpacked` for what cannot. See
scripts/pack_node_modules_asar.mjs for the three sets and why each exists.

The line that has to hold for this to work is `spawn`. Electron's asar layer is
in its file system, not in its process spawner, so an executable inside the
archive fails with ENOTDIR. VS Code spawns several — ripgrep for search,
node-pty's `spawn-helper` for terminals — and reaches them by paths it computes
itself from `__dirname`; upstream's answer is a convention its source hard-codes
at every such place, rewriting the segment `node_modules.asar` in the computed
path to `node_modules.asar.unpacked`. That is why the archive has to be named
exactly that, and why the unpack list is not a tuning knob: a spawned file
missing from it is a feature that fails at runtime, not a bigger archive.

An earlier round of this work recorded the opposite conclusion — that Electron
"no longer resolves modules out of a sibling `node_modules.asar`", making the
archive unusable. That is not the case on Electron 42, and probably never was
the whole story: Node's own resolver indeed cannot see into the archive, but
resolving out of it was never Node's job. Upstream installs an ESM resolution
hook (`enableASARSupport` in `src/bootstrap-esm.ts`) that locates the package
inside the archive and re-runs resolution rooted there. Measured on 42.7.0 with
the hook wired: `fs` reads, `require`, and bare `import` all resolve out of the
archive; `spawn` works from `.unpacked` and fails from inside, exactly as the
design assumes. The earlier measurement was almost certainly taken with that
hook disabled, which was the state DevHub's own patch had left it in.

Usage:
    scripts/package-nightly.py [--out-dir DIR] [--zip] [--zip-name NAME]

Requires an already-built tree; every missing input names the command that
produces it. The result is unsigned beyond an ad-hoc signature, which is the
minimum macOS accepts for a modified bundle on Apple Silicon.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"
BRIDGE_DIR = REPO_ROOT / "extensions" / "devhub-bridge"

# Everything DevHub says about itself that VS Code reads out of product.json —
# its name, its data folders, its extension gallery, and which build this is —
# comes from product_metadata.py. The packaged app gets it merged into
# product.json below; a source run gets it through vscode/product.overrides.json,
# which apps/desktop/scripts/dev.sh writes by running that same module. Neither
# path restates a value the other one owns.
#
# Renaming the Electron bundle after those same names is a source run's problem
# too — macOS names an application from the bundle it runs in — so that rename
# lives in darwin_bundle.py and both callers import it from there.
from darwin_bundle import (  # noqa: E402
	APP_NAME,
	BASE_APP,
	rebrand,
	sign,
)
from product_metadata import devhub_commit, devhub_version, packaged_metadata  # noqa: E402
from smoke_packaged_app import smoke  # noqa: E402

# The inline `//# sourceMappingURL=data:...` tail every file of the dev compile
# carries. It is about half the weight of `out/` and means nothing without the
# sources, which are not shipped.
INLINE_SOURCE_MAP = re.compile(rb"\n//# sourceMappingURL=data:[^\n]*\n?$")


def fail(message: str) -> "None":
	print(f"error: {message}", file=sys.stderr)
	raise SystemExit(1)


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
	print(f"    $ {' '.join(argv)}")
	return subprocess.run(argv, check=True, **kwargs)


def step(message: str) -> None:
	print(f"\n==> {message}")


# --- inputs ----------------------------------------------------------------


def toolchain_node_bin() -> Path:
	"""The Node that VS Code's build insists on, as provisioned beside the repo."""
	version = (VSCODE_DIR / ".nvmrc").read_text().strip()
	machine = os.uname().machine
	arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
	home = REPO_ROOT / "vscode-toolchain" / f"node-v{version}-darwin-{arch}" / "bin"
	if not (home / "node").exists():
		fail(f"no Node toolchain at {home} — run scripts/provision-vscode.sh")
	return home


def _newest_mtime(root: Path) -> float:
	"""The most recently written file anywhere under `root`, or 0 if there is none."""
	newest = 0.0
	for path in root.rglob("*"):
		if path.is_file():
			newest = max(newest, path.stat().st_mtime)
	return newest


def check_compiled_output_is_current() -> None:
	"""Refuse to ship a compile older than the source it was made from.

	`out/` and `dist/` are build output that packaging copies verbatim; nothing
	here rebuilds them. So an edit that was never compiled ships as the
	*previous* compile, and nothing about the result says so — the app starts,
	the smoke test passes, and only whatever the change was supposed to do is
	quietly missing. That is how a packaged build once shipped without the
	workbench default that turns off extension signature verification, and
	answered every gallery install with "Signature verification was not
	executed".

	Comparing timestamps is coarse, and it will occasionally ask for a rebuild
	that changes nothing. That is the cheap side of the trade: a rebuild costs
	seconds, and shipping yesterday's compile costs however long it takes
	someone to stop believing the source in front of them.
	"""
	for source, built, command in (
		(DESKTOP_DIR / "src", DESKTOP_DIR / "out", "pnpm --filter @devhub/desktop build"),
		(DESKTOP_DIR / "src", DESKTOP_DIR / "dist", "pnpm --filter @devhub/desktop build"),
		(BRIDGE_DIR / "src", BRIDGE_DIR / "dist", "pnpm --filter @devhub/bridge build"),
	):
		if not source.is_dir() or not built.is_dir():
			continue
		if _newest_mtime(source) > _newest_mtime(built):
			fail(
				f"{built} is older than {source}\n"
				f"       it would ship the previous compile — rebuild with: {command}"
			)


def check_inputs() -> None:
	required = [
		(BASE_APP, "scripts/provision-vscode.sh"),
		(VSCODE_DIR / "out-vscode-min" / "main.js", "scripts/provision-vscode.sh"),
		(VSCODE_DIR / "node_modules" / "electron", "scripts/provision-vscode.sh"),
		(DESKTOP_DIR / "out" / "main" / "main.js", "pnpm --filter @devhub/desktop build"),
		(DESKTOP_DIR / "dist" / "shell" / "index.html", "pnpm --filter @devhub/desktop build"),
		(BRIDGE_DIR / "dist" / "extension.js", "pnpm --filter @devhub/bridge build"),
	]
	for path, command in required:
		if not path.exists():
			fail(f"missing {path}\n       produce it with: {command}")

	check_compiled_output_is_current()

	# The same state provision-vscode.sh stamps: the submodule HEAD plus the
	# patch contents, so a bumped submodule with unchanged patches is stale too.
	stamp = VSCODE_DIR / ".build" / "devhub-source.stamp"
	patches = sorted((REPO_ROOT / "patches" / "vscode").glob("*.patch"))
	head = subprocess.run(
		["git", "-C", str(VSCODE_DIR), "rev-parse", "HEAD"],
		capture_output=True, check=True, text=True,
	).stdout
	# The shell's command substitution strips trailing newlines before the
	# shasum; reproduce that byte-for-byte or the two sides disagree forever.
	source_state = (head.encode() + b"".join(p.read_bytes() for p in patches)).rstrip(b"\n")
	state = subprocess.run(
		["shasum"], input=source_state,
		capture_output=True, check=True,
	).stdout.split()[0].decode()
	if not stamp.exists() or stamp.read_text().strip() != state:
		fail(
			"vscode/out was not compiled from the current patches/vscode/*"
			"\n       run: scripts/provision-vscode.sh"
		)


def build_builtin_extensions() -> Path:
	"""Production-bundle the built-in extension set with VS Code's own task.

	The extension directories in the checkout carry every dev dependency of
	every extension — 3.5 GB of it. `compile-extensions-build` is the task
	upstream's own packaging uses: esbuild bundles each extension and only its
	production dependencies land in `.build/extensions`.
	"""
	env = dict(os.environ, PATH=f"{toolchain_node_bin()}:{os.environ['PATH']}")
	run(["npm", "run", "gulp", "compile-extensions-build"], cwd=VSCODE_DIR, env=env)
	staged = VSCODE_DIR / ".build" / "extensions"
	if not staged.is_dir():
		fail(f"compile-extensions-build produced no {staged}")
	return staged


def production_dependencies() -> list[Path]:
	"""VS Code's production dependency closure, as npm reports it.

	The same query `vscode/build/lib/dependencies.ts` runs for the real
	packaging step. The directories are copied out of the checkout rather than
	installed fresh: the native modules there are already built against exactly
	this Electron.
	"""
	env = dict(
		os.environ,
		PATH=f"{toolchain_node_bin()}:{os.environ['PATH']}",
		NODE_ENV="production",
	)
	# `npm ls` exits non-zero on any peer-dependency complaint while still
	# printing the tree, so the output is used regardless of the status.
	result = subprocess.run(
		["npm", "ls", "--all", "--omit=dev", "--parseable"],
		cwd=VSCODE_DIR, env=env, capture_output=True, text=True,
	)
	paths = [Path(line) for line in result.stdout.splitlines() if line.strip()]
	modules = [p for p in paths if "node_modules" in p.parts]
	if not modules:
		fail(f"npm ls listed no production dependencies\n{result.stderr}")
	return modules


# Everything the packaged app gets from somewhere other than node_modules:
# Node's own builtins, Electron's, and the submodule, which is materialised by
# hand a few steps further down.
NOT_A_DEPENDENCY = {"electron", "original-fs", "fs", "code-oss-dev"}

# The two native modules DevHub's copy of VS Code's bootstrap imports inside
# `if (isWindows)`. They belong to VS Code, not to this app, they cannot be
# reached from the packaged `out/`, and nothing on macOS ever asks for them.
# Any *other* unresolvable import is a packaging bug and stops the build.
WINDOWS_ONLY = {"@vscode/windows-mutex", "windows-foreground-love"}

# What the compiled main process imports, according to a parser rather than a
# pattern. `preProcessFile` is TypeScript's own module scanner: it reads static
# imports, dynamic `import()`, re-exports and `require`, and it knows the
# difference between code and the comments and string literals around it.
#
# A regex could not. It read the words `from "clean"` out of a sentence in a doc
# comment and spent the rest of the build looking for a package by that name.
# The scan decides what gets copied into the app, so anything it gets wrong is
# either a missing dependency at runtime or a build that stops — and it cannot
# tell prose from code without parsing it.
SCAN_HELPER = """
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const [base, root] = process.argv.slice(1);
const ts = createRequire(path.join(base, 'resolve.js'))('typescript');

const specifiers = new Set();
(function walk(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (entry.name.endsWith('.js')) {
			const source = fs.readFileSync(full, 'utf8');
			for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
				specifiers.add(fileName);
			}
		}
	}
})(root);
console.log(JSON.stringify([...specifiers].sort()));
"""


# The helper below is Node's own resolver, which is the only thing that
# understands pnpm's store layout. `<pkg>/package.json` is not always exported,
# so a package that hides it is found by walking up from its entry point.
RESOLVE_HELPER = """
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function packageDirectory(specifier, base) {
	const require_ = createRequire(path.join(base, 'resolve.js'));
	try {
		return path.dirname(require_.resolve(`${specifier}/package.json`));
	} catch {}
	let directory = path.dirname(require_.resolve(specifier));
	while (!fs.existsSync(path.join(directory, 'package.json'))) {
		directory = path.dirname(directory);
	}
	return directory;
}

// `node -e` leaves the arguments at argv[1] onwards: there is no script path.
const [base, ...specifiers] = process.argv.slice(1);
const found = new Map();
const queue = specifiers.map((specifier) => [specifier, base]);
while (queue.length) {
	const [specifier, from] = queue.shift();
	const directory = packageDirectory(specifier, from);
	const seen = found.get(specifier);
	if (seen) {
		if (seen !== directory) {
			throw new Error(`two versions of ${specifier}: ${seen} and ${directory}`);
		}
		continue;
	}
	found.set(specifier, directory);
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
	for (const dependency of Object.keys(manifest.dependencies ?? {})) {
		queue.push([dependency, directory]);
	}
}
console.log(JSON.stringify(Object.fromEntries(found)));
"""


def main_process_dependencies(out_dir: Path) -> dict[str, Path]:
	"""Every npm package the packaged main process actually imports.

	Read off the compiled tree rather than off `package.json`: what the main
	process needs at runtime and what the manifest calls a dependency are not
	the same list (`toml-eslint-parser` is a dev dependency there and an import
	here), and a package built from the manifest would launch and then fail on
	the first configuration read.
	"""
	scan = subprocess.run(
		["node", "-e", SCAN_HELPER, str(DESKTOP_DIR), str(out_dir)],
		cwd=DESKTOP_DIR, capture_output=True, text=True,
	)
	if scan.returncode != 0:
		fail(f"could not read the main process's imports:\n{scan.stderr}")

	specifiers: set[str] = set()
	for specifier in json.loads(scan.stdout):
		if specifier.startswith(".") or specifier.startswith("node:"):
			continue
		# A deep import (`pkg/sub.js`) still means the package.
		parts = specifier.split("/")
		name = "/".join(parts[:2]) if specifier.startswith("@") else parts[0]
		if name in NOT_A_DEPENDENCY or name in WINDOWS_ONLY:
			continue
		specifiers.add(name)

	result = subprocess.run(
		["node", "-e", RESOLVE_HELPER, str(DESKTOP_DIR), *sorted(specifiers)],
		cwd=DESKTOP_DIR, capture_output=True, text=True,
	)
	if result.returncode != 0:
		fail(f"could not resolve the main process's dependencies:\n{result.stderr}")
	return {name: Path(directory) for name, directory in json.loads(result.stdout).items()}


# --- copying ---------------------------------------------------------------


def copy_tree(source: Path, target: Path, ignore=None) -> None:
	target.parent.mkdir(parents=True, exist_ok=True)
	shutil.copytree(source, target, symlinks=True, ignore=ignore, dirs_exist_ok=True)


def ignore_tests(directory: str, names: list[str]) -> set[str]:
	"""Everything a running app never reads: tests, and nested installs."""
	drop = {n for n in names if n.endswith(".test.js") or n.endswith(".test.d.ts")}
	drop |= {n for n in names if n in ("test", "tests", "node_modules", ".git")}
	return drop


# node-gyp's own generated build files, as opposed to what it built. They are
# named the same way in every native module: one `<target>.target.mk` per
# target, the makefiles that drive them, and a `deps/` of more of the same.
NODE_GYP_LEFTOVERS = ("Makefile", "binding.Makefile", "config.gypi", "gyp-mac-tool", "deps")


def ignore_native_build_intermediates(directory: str, names: list[str]) -> set[str]:
	"""node-gyp's leftovers, which spell out the machine that compiled them.

	A native module's `build/` holds the linked addon in `Release/` and, beside
	it, the makefiles node-gyp generated on the way there — and every one of
	those repeats the compiling machine's home directory in its include flags
	(`-I/Users/<someone>/Library/Caches/node-gyp/...`). Nothing at runtime opens
	them, so shipping them only means a zip built on a laptop carries that
	laptop's user name to whoever it is handed to. Drop them; keep `Release`,
	which is the part that is actually loaded.
	"""
	if Path(directory).name != "build":
		return set()
	return {n for n in names if n.endswith((".target.mk", ".o")) or n in NODE_GYP_LEFTOVERS}


def strip_inline_source_maps(root: Path) -> tuple[int, int]:
	saved = 0
	touched = 0
	for path in root.rglob("*.js"):
		data = path.read_bytes()
		stripped = INLINE_SOURCE_MAP.sub(b"\n", data)
		if len(stripped) != len(data):
			path.write_bytes(stripped)
			saved += len(data) - len(stripped)
			touched += 1
	return touched, saved


def directory_size(root: Path) -> int:
	return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


# --- the bundle ------------------------------------------------------------


def rename_bundle(app: Path) -> None:
	"""Make the Electron bundle DevHub's, and say which DevHub it is.

	The rename itself is `darwin_bundle.rebrand`, shared with the source run's
	bundle so that the two cannot come to disagree about what DevHub is called,
	what it looks like or what version it is — the icon and
	`CFBundleShortVersionString` travel with the rename, in there. What only a
	release knows is added here: which build this is.

	"About DevHub" is the macOS About panel — `{ role: "about" }` in the App
	Shell's menu — and it reads these two keys, not anything the workbench
	knows. So the build's commit goes here as well as into product.json: a
	nightly that cannot be told from the one before it is a bug report nobody
	can act on. The panel renders them as `Version <short> (<version>)`.
	"""
	rebrand(
		app,
		{
			"CFBundleVersion": f"{devhub_version()}.{date.today():%Y%m%d}+{devhub_commit()[:10]}",
		},
	)


def write_licenses(app: Path) -> None:
	"""The licences of everything the bundle redistributes, inside the bundle.

	DevHub ships VS Code and Electron now, so their terms travel with it.
	"""
	licenses = app / "Contents" / "Resources" / "licenses"
	licenses.mkdir(parents=True, exist_ok=True)
	for source, name in (
		(REPO_ROOT / "LICENSE", "DevHub-MIT.txt"),
		(REPO_ROOT / "distribution" / "THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"),
		(VSCODE_DIR / "LICENSE.txt", "Code-OSS-MIT.txt"),
		(VSCODE_DIR / "ThirdPartyNotices.txt", "Code-OSS-ThirdPartyNotices.txt"),
		(VSCODE_DIR / ".build" / "electron" / "LICENSE", "Electron-MIT.txt"),
	):
		if not source.exists():
			fail(f"missing licence text {source}")
		shutil.copyfile(source, licenses / name)
	for text in sorted((REPO_ROOT / "distribution" / "licenses").glob("*.txt")):
		shutil.copyfile(text, licenses / text.name)


def bundle_main_process(target: Path) -> None:
	"""DevHub's main process, bundled the way upstream bundles its own.

	Upstream's `src/main.ts` is a bundle entry point (`bootstrapEntryPoints` in
	build/gulpfile.vscode.ts): everything the main process imports is folded
	into one `out/main.js`, which is why a shipped VS Code has 25 files under
	`out/vs` and not seven thousand. DevHub's `main.ts` is that file's
	replacement, so it is bundled the same way and lands in the same place.

	The place is load-bearing, not cosmetic. VS Code computes its own roots
	from wherever the running bundle sits — `appRoot` is the parent of
	`import.meta.dirname` (bootstrap-node.ts), `_VSCODE_FILE_ROOT` is that
	directory itself (bootstrap-esm.ts), and `NODE_MODULES_PATH` hangs off it
	too. Put DevHub's bundle at upstream's own `out/main.js` and every one of
	those resolves exactly as upstream means it to, because it *is* upstream's
	path. Put it anywhere else and each of them would need its own correction.

	Externals are the packages, not the modules: the app ships `node_modules`,
	so bare specifiers stay requires, while `code-oss-dev/...` is aliased to
	the submodule so the VS Code half is what gets folded in.
	"""
	esbuild = VSCODE_DIR / "build" / "node_modules" / ".bin" / "esbuild"
	if not esbuild.exists():
		fail(f"missing {esbuild}\n       produce it with: scripts/provision-vscode.sh")
	target.parent.mkdir(parents=True, exist_ok=True)
	run([
		str(esbuild),
		str(DESKTOP_DIR / "out" / "main" / "main.js"),
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--target=node22",
		"--packages=external",
		f"--alias:code-oss-dev={VSCODE_DIR}",
		f"--outfile={target}",
	])
	print(f"    bundled the main process into {target.name} ({target.stat().st_size / 1e6:.1f} MB)")


def write_product_json(target: Path) -> None:
	"""VS Code's product metadata, saying DevHub where it says Code - OSS.

	`packaged_metadata` carries DevHub's names, the build it was made from, and
	`commit` — which VS Code reads as "this is a built layout", and which only
	a packaged app may state. A source run gets everything but that field,
	through `vscode/product.overrides.json`, from the same module. See the
	docstring of scripts/product_metadata.py.
	"""
	product = json.loads((VSCODE_DIR / "product.json").read_text())
	product.update(packaged_metadata())
	target.write_text(json.dumps(product, indent="\t") + "\n")


ENTRY_SOURCE = '''\
/**
 * The packaged app's entry point.
 *
 * `apps/desktop/scripts/dev.sh` hands VS Code's Electron an environment and a
 * set of directories before it runs DevHub's main process. A double-clicked
 * app has neither a shell to set them nor arguments to carry them, so the
 * packaged bundle sets exactly the same directories here.
 *
 * What it does not set is `VSCODE_DEV`, and that is the whole difference
 * between this app and a `dev.sh` run. See "the two layouts" at the top of
 * scripts/package-nightly.py.
 *
 * Explicit arguments still win, so a scratch run can point the app at a
 * throwaway user-data directory the way a test needs.
 *
 * Generated by scripts/package-nightly.py. Do not edit inside the bundle.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** DevHub's own state, beside the user's real VS Code state, never inside it. */
const state = join(homedir(), "Library", "Application Support", "DevHub");

for (const [flag, value] of [
\t["--user-data-dir", join(state, "editor")],
\t["--extensions-dir", join(state, "extensions")],
]) {
\tconst given = process.argv.some(
\t\t(arg) => arg === flag || arg.startsWith(`${flag}=`),
\t);
\tif (!given) {
\t\tprocess.argv.push(flag, value);
\t}
}

// The bundled main process, at upstream's own entry path. `out/main/` beside
// this file is the module-by-module compile the bundle was built from; it
// still ships, because the preload script, the App Shell page and the `devhub`
// CLI are loaded from it by path, but nothing imports it.
await import("./node_modules/code-oss-dev/out/main.js");
'''


def assemble_app_directory(app: Path, version: str, staged_extensions: Path) -> None:
	resources = app / "Contents" / "Resources" / "app"
	shutil.rmtree(resources, ignore_errors=True)
	resources.mkdir(parents=True)

	step("DevHub's own code")
	copy_tree(DESKTOP_DIR / "out", resources / "out", ignore=ignore_tests)
	copy_tree(DESKTOP_DIR / "dist", resources / "dist")
	(resources / "devhub-main.js").write_text(ENTRY_SOURCE)
	(resources / "package.json").write_text(
		json.dumps(
			{
				"name": "devhub",
				"version": version,
				"private": True,
				"type": "module",
				"main": "devhub-main.js",
			},
			indent="\t",
		)
		+ "\n"
	)

	step("the main process's own dependencies")
	for name, source in main_process_dependencies(resources / "out").items():
		print(f"    {name}")
		copy_tree(source, resources / "node_modules" / name, ignore=ignore_tests)

	code_oss = resources / "node_modules" / "code-oss-dev"

	step("vscode/out-vscode-min")
	# The bundled tree, not the module-by-module compile: one file per process
	# instead of the whole source graph. Source maps are external here rather
	# than inline, so they are simply not copied.
	copy_tree(
		VSCODE_DIR / "out-vscode-min",
		code_oss / "out",
		ignore=lambda d, names: ignore_tests(d, names)
		| {n for n in names if n.endswith(".map")},
	)
	print(f"    {directory_size(code_oss / 'out') / 1e6:.0f} MB bundled")

	step("DevHub's main process")
	# Overwrites upstream's own bundled entry: DevHub's main.ts *is* the
	# replacement for the src/main.ts that produced it. See the function.
	bundle_main_process(code_oss / "out" / "main.js")

	step("vscode metadata")
	shutil.copyfile(VSCODE_DIR / "package.json", code_oss / "package.json")
	write_product_json(code_oss / "product.json")
	for name in ("LICENSE.txt", "ThirdPartyNotices.txt"):
		source = VSCODE_DIR / name
		if source.exists():
			shutil.copyfile(source, code_oss / name)

	step("built-in extensions")
	copy_tree(staged_extensions, code_oss / "extensions")
	copy_tree(
		BRIDGE_DIR,
		code_oss / "extensions" / "devhub-bridge",
		ignore=lambda d, names: ignore_tests(d, names) | {"src", "build", "scripts", "tsconfig.json"},
	)
	count = len([p for p in (code_oss / "extensions").iterdir() if p.is_dir()])
	print(f"    {count} built-in extensions")

	step("vscode production dependencies")
	skipped = 0
	for module in production_dependencies():
		# The Copilot *runtime binary* is a quarter of the whole bundle and
		# nothing in DevHub starts it: the extension that would is a marketplace
		# VSIX upstream downloads at release time, not part of the built-in set.
		#
		# Its SDK is a different matter, and the bundled build is why. Unbundled,
		# `copilotAgent.js` was a module the agent host loaded only if it got
		# that far, so a missing `@github/copilot-sdk` was a path never taken.
		# Bundling folds the whole import graph into `agentHostMain.js`, which
		# turns that into a require at load — and the agent host died on startup
		# with ERR_MODULE_NOT_FOUND. Eight megabytes is the honest price of a
		# static dependency; the 253 MB platform binary is still not one.
		if "@github" in module.parts and module.name not in ("copilot", "copilot-sdk"):
			skipped += 1
			continue
		relative = module.relative_to(VSCODE_DIR)
		copy_tree(
			module,
			code_oss / relative,
			ignore=lambda d, names: {"node_modules"} | ignore_native_build_intermediates(d, names),
		)
	print(f"    copied the production closure, minus {skipped} Copilot packages")

	step("node_modules.asar")
	run(
		[
			str(toolchain_node_bin() / "node"),
			str(REPO_ROOT / "scripts" / "pack_node_modules_asar.mjs"),
			str(code_oss / "node_modules"),
			str(VSCODE_DIR),
		]
	)


# --- entry point -----------------------------------------------------------


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--out-dir", default=str(REPO_ROOT / "dist"), help="where DevHub.app is written")
	parser.add_argument("--zip", action="store_true", help="also produce a zip with ditto")
	parser.add_argument("--zip-name", default=None, help="the zip's file name")
	parser.add_argument(
		"--skip-smoke",
		action="store_true",
		help="do not start the packaged app to check that it answers",
	)
	parser.add_argument(
		"--smoke-timeout",
		type=float,
		default=90.0,
		help="how long the smoke test waits for a reply before calling it stalled",
	)
	parser.add_argument(
		"--skip-extension-build",
		action="store_true",
		help="reuse an existing vscode/.build/extensions instead of rebuilding it",
	)
	args = parser.parse_args()

	if sys.platform != "darwin":
		fail("this packages a macOS app bundle and only runs on macOS")

	step("inputs")
	check_inputs()
	version = devhub_version()
	print(f"    DevHub {version}")

	step("built-in extension set")
	staged = VSCODE_DIR / ".build" / "extensions"
	if args.skip_extension_build:
		if not staged.is_dir():
			fail(f"--skip-extension-build was given but {staged} does not exist")
		print(f"    reusing {staged}")
	else:
		staged = build_builtin_extensions()

	out_dir = Path(args.out_dir).resolve()
	app = out_dir / f"{APP_NAME}.app"
	step(f"base bundle -> {app}")
	shutil.rmtree(app, ignore_errors=True)
	out_dir.mkdir(parents=True, exist_ok=True)
	# ditto, not copytree: the Electron bundle is full of framework symlinks and
	# signed binaries, and ditto is the only copier macOS guarantees for those.
	run(["ditto", str(BASE_APP), str(app)])

	step("bundle identity")
	rename_bundle(app)
	write_licenses(app)

	assemble_app_directory(app, version, staged)

	step("ad-hoc signature")
	# An Apple Silicon Mac refuses to run a modified bundle with no signature at
	# all. Ad-hoc is not notarisation: the first launch still needs
	# `xattr -dr com.apple.quarantine`.
	sign(app)

	print(f"\n    {app}  {directory_size(app) / 1e6:.0f} MB")

	if args.skip_smoke:
		step("start-up smoke test: skipped")
	else:
		# A bundle that assembles and verifies can still be inert: the app comes
		# up, shows its window, and answers nothing, because its main thread is
		# parked in a synchronous macOS call and Electron has stopped pumping
		# libuv behind it. Only asking the running app something catches that.
		step("start-up smoke test")
		if smoke(app, timeout=args.smoke_timeout) != 0:
			fail("the packaged app never answered on its control socket")

	if args.zip:
		name = args.zip_name or f"{APP_NAME}-darwin-arm64-{date.today():%Y%m%d}.zip"
		archive = out_dir / name
		archive.unlink(missing_ok=True)
		step(f"zip -> {archive}")
		run(["ditto", "-c", "-k", "--keepParent", str(app), str(archive)])
		print(f"\n    {archive}  {archive.stat().st_size / 1e6:.0f} MB")

	print("\npackaged.")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
