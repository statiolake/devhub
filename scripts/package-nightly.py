#!/usr/bin/env python3
"""Assemble a runnable DevHub.app for macOS Apple Silicon.

A source run (apps/desktop/scripts/dev.sh) and the packaged app run the same
thing: npm's Electron at the version apps/desktop/package.json pins, loading
`apps/desktop` — `out/main/main.js`, the module tree tsgo emitted, and the
pages Vite built. Packaging copies that tree into the bundle as it is; nothing
is bundled again and nothing is archived, so there is one layout to reason
about and Node's own resolver finds every dependency in every process.

    DevHub.app/Contents/
      MacOS/DevHub                  npm's Electron, renamed
      Frameworks/DevHub Helper*.app renamed with it — Electron finds its child
                                    processes by the main bundle's name
      Info.plist                    DevHub's names, version, document types
                                    (scripts/darwin_bundle.py)
      Resources/DevHub.icns
      Resources/licenses/           DevHub's, Electron's, the third parties'
      Resources/whisper/            the speech recogniser the GUI Agent
                                    composer dictates with (build_whisper.py)
      Resources/app/                what Electron loads (`APP_ROOT`)
        package.json                "main": "out/main/main.js"
        product.json                apps/desktop/product.json + version, commit
        out/  dist/                 apps/desktop's build, minus its tests
        node_modules/               what `out/` imports, resolved by Node from
                                    apps/desktop and copied as real files —
                                    node-pty with this platform's prebuild only

`out/vt/ghostty-vt.wasm` (libghostty-vt, the control-mode terminal's engine)
and `out/native/` (DevHub's helpers) travel inside `out/`.

Usage:
    scripts/package-nightly.py [--out-dir DIR] [--zip] [--zip-name NAME]
                               [--zip-level 0-9|ditto]
                               [--whisper-dir DIR | --without-whisper]
    scripts/package-nightly.py --layout-only DIR

`--layout-only DIR` writes only `Resources/app` (into DIR), on any platform:
it is how the packaged layout is checked on Linux
(scripts/check_packaged_layout.py). Everything else needs macOS.

Requires a built `apps/desktop` (`pnpm run build:packages`). The result is
signed ad hoc, which is the minimum macOS accepts for a modified bundle on
Apple Silicon; it is not notarized.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"

import build_cache  # noqa: E402
from build_whisper import (  # noqa: E402
	DEFAULT_OUT_DIR as WHISPER_BUILD_DIR,
	chosen_model as chosen_whisper_model,
	ensure as ensure_whisper,
	install_problems as whisper_install_problems,
)
from product_metadata import devhub_commit, devhub_version, packaged_product  # noqa: E402


def fail(message: str) -> "None":
	print(f"error: {message}", file=sys.stderr)
	raise SystemExit(1)


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
	print(f"    $ {' '.join(argv)}")
	return subprocess.run(argv, check=True, **kwargs)


def step(message: str) -> None:
	print(f"\n==> {message}")


# --- inputs ----------------------------------------------------------------


def _newest_mtime(root: Path) -> float:
	newest = 0.0
	for path in root.rglob("*"):
		if path.is_file():
			newest = max(newest, path.stat().st_mtime)
	return newest


def check_inputs() -> None:
	"""A built apps/desktop, and not one older than its sources.

	`out/` and `dist/` are copied verbatim; nothing here rebuilds them. So an
	edit that was never compiled would ship as the *previous* compile, and
	nothing about the result would say so. Nor is anything filtered out of
	them: apps/desktop's `build` deletes both before it compiles (its `clean`
	script), so they hold what the current sources emit and nothing a source
	since deleted left behind — which the dependency scan below would
	otherwise read, and fail on, as if it were live code.
	"""
	for required in (
		DESKTOP_DIR / "out" / "main" / "main.js",
		DESKTOP_DIR / "out" / "preload" / "shell.js",
		DESKTOP_DIR / "out" / "vt" / "ghostty-vt.wasm",
		DESKTOP_DIR / "dist" / "shell" / "index.html",
	):
		if not required.exists():
			fail(f"missing {required}\n       produce it with: pnpm run build:packages")
	for built in (DESKTOP_DIR / "out", DESKTOP_DIR / "dist"):
		if _newest_mtime(DESKTOP_DIR / "src") > _newest_mtime(built):
			fail(
				f"{built} is older than {DESKTOP_DIR / 'src'}\n"
				"       it would ship the previous compile — rebuild with: pnpm run build:packages"
			)


# --- the main process's dependencies ---------------------------------------

# Node's builtins and Electron's: never copied.
NOT_A_DEPENDENCY = {"electron", "original-fs"}

# What the compiled tree imports, according to a parser rather than a pattern:
# TypeScript's own module scanner reads static imports, dynamic `import()`,
# re-exports and `require`, and knows code from the comments around it.
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

# Node's own resolver, the only thing that understands pnpm's store layout,
# walking each package's `dependencies` so the closure is whole. A package that
# hides its `package.json` is found by walking up from its entry point.
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


def package_name(specifier: str) -> str | None:
	"""The package a bare specifier names, or None for a relative or builtin one."""
	if specifier.startswith((".", "/", "node:")):
		return None
	parts = specifier.split("/")
	name = "/".join(parts[:2]) if specifier.startswith("@") else parts[0]
	return None if name in NOT_A_DEPENDENCY else name


def main_process_dependencies(out_dir: Path) -> dict[str, Path]:
	"""Every npm package the compiled tree imports, with its own dependencies."""
	scan = subprocess.run(
		["node", "-e", SCAN_HELPER, str(DESKTOP_DIR), str(out_dir)],
		cwd=DESKTOP_DIR, capture_output=True, text=True,
	)
	if scan.returncode != 0:
		fail(f"could not read the main process's imports:\n{scan.stderr}")
	names = sorted(
		{name for name in map(package_name, json.loads(scan.stdout)) if name is not None}
		- set(sys.builtin_module_names)
		- NODE_BUILTINS
	)
	result = subprocess.run(
		["node", "-e", RESOLVE_HELPER, str(DESKTOP_DIR), *names],
		cwd=DESKTOP_DIR, capture_output=True, text=True,
	)
	if result.returncode != 0:
		fail(f"could not resolve the main process's dependencies:\n{result.stderr}")
	return {name: Path(directory) for name, directory in json.loads(result.stdout).items()}


# Node's builtin modules imported without `node:` (`fs`, `path`, …).
NODE_BUILTINS = set(
	json.loads(
		subprocess.run(
			["node", "-p", "JSON.stringify(require('node:module').builtinModules)"],
			capture_output=True, text=True, check=True,
		).stdout
	)
)


# --- copying ---------------------------------------------------------------


def ignore_tests(directory: str, names: list[str]) -> set[str]:
	"""Everything a running app never reads: tests, and nested installs."""
	drop = {n for n in names if n.endswith((".test.js", ".test.d.ts", ".map"))}
	drop |= {n for n in names if n in ("test", "tests", "test-terminal", "node_modules", ".git")}
	return drop


def ignore_other_platforms(platform: str):
	"""node-pty ships a prebuild per platform; the app carries its own only."""

	def ignore(directory: str, names: list[str]) -> set[str]:
		drop = ignore_tests(directory, names)
		if Path(directory).name == "prebuilds":
			drop |= {n for n in names if n != platform}
		# node-pty's sources, its build scripts and its Windows halves.
		if Path(directory).name == "node-pty":
			drop |= {n for n in names if n in ("src", "scripts", "third_party", "deps", "binding.gyp", "typings")}
		return drop

	return ignore


def copy_tree(source: Path, target: Path, ignore=None) -> None:
	target.parent.mkdir(parents=True, exist_ok=True)
	shutil.copytree(source, target, symlinks=False, ignore=ignore, dirs_exist_ok=True)


def directory_size(root: Path) -> int:
	return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


def assemble_app_directory(resources: Path, platform: str) -> None:
	"""`Resources/app`: the build, its metadata, and its dependencies."""
	shutil.rmtree(resources, ignore_errors=True)
	resources.mkdir(parents=True)

	step("DevHub's own code")
	copy_tree(DESKTOP_DIR / "out", resources / "out", ignore=ignore_tests)
	copy_tree(DESKTOP_DIR / "dist", resources / "dist")
	manifest = json.loads((DESKTOP_DIR / "package.json").read_text())
	(resources / "package.json").write_text(
		json.dumps(
			{
				"name": "devhub",
				"version": devhub_version(),
				"private": True,
				"type": manifest.get("type", "module"),
				"main": manifest["main"],
			},
			indent="\t",
		)
		+ "\n"
	)
	(resources / "product.json").write_text(json.dumps(packaged_product(), indent="\t") + "\n")
	print(f"    {directory_size(resources) / 1e6:.0f} MB")

	step("the main process's dependencies")
	ignore = ignore_other_platforms(platform)
	for name, source in main_process_dependencies(resources / "out").items():
		print(f"    {name}")
		copy_tree(source, resources / "node_modules" / name, ignore=ignore)
	print(f"    {directory_size(resources / 'node_modules') / 1e6:.0f} MB")


# --- the bundle ------------------------------------------------------------


def write_licenses(app: Path, electron_dir: Path) -> None:
	licenses = app / "Contents" / "Resources" / "licenses"
	licenses.mkdir(parents=True, exist_ok=True)
	for source, name in (
		(REPO_ROOT / "LICENSE", "DevHub-MIT.txt"),
		(REPO_ROOT / "distribution" / "THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"),
		(electron_dir / "LICENSE", "Electron-MIT.txt"),
		(electron_dir / "LICENSES.chromium.html", "Chromium-LICENSES.html"),
	):
		if not source.exists():
			fail(f"missing licence text {source}")
		shutil.copyfile(source, licenses / name)
	for text in sorted((REPO_ROOT / "distribution" / "licenses").glob("*.txt")):
		shutil.copyfile(text, licenses / text.name)


def bundle_whisper(app: Path, whisper_dir: Path) -> None:
	"""Put the speech recogniser in the app, or refuse to package."""
	problems = whisper_install_problems(whisper_dir, model=chosen_whisper_model())
	if problems:
		fail(
			"the speech recogniser is not ready to bundle:\n  "
			+ "\n  ".join(problems)
			+ "\nBuild it with scripts/build_whisper.py, or pass --without-whisper "
			"for a bundle whose composer has no voice input."
		)
	target = app / "Contents" / "Resources" / "whisper"
	shutil.rmtree(target, ignore_errors=True)
	shutil.copytree(whisper_dir, target, ignore=lambda d, names: {n for n in names if n.endswith(".part")})
	# A Mach-O under Resources is sealed as a resource by the bundle's
	# signature, not signed as code, and Apple Silicon kills an arm64 program
	# with no signature of its own the moment it is spawned.
	for program in ("devhub-whisper", "devhub-whisper-server"):
		run(["codesign", "--force", "--sign", "-", str(target / program)])
	print(f"    {directory_size(target) / 1e6:.0f} MB")


def node_platform() -> str:
	machine = os.uname().machine
	arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
	return f"{sys.platform if sys.platform != 'darwin' else 'darwin'}-{arch}"


# --- entry point -----------------------------------------------------------


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--out-dir", default=str(REPO_ROOT / "dist"), help="where DevHub.app is written")
	parser.add_argument("--zip", action="store_true", help="also produce a zip")
	parser.add_argument("--zip-name", default=None, help="the zip's file name")
	parser.add_argument(
		"--zip-level",
		default=os.environ.get("DEVHUB_ZIP_LEVEL", "1"),
		help="deflate level 0-9 (0 stores) or 'ditto' for ditto's default (env DEVHUB_ZIP_LEVEL)",
	)
	parser.add_argument(
		"--whisper-dir",
		default=str(WHISPER_BUILD_DIR),
		help="where scripts/build_whisper.py left the speech recogniser (built there if missing)",
	)
	parser.add_argument(
		"--without-whisper",
		action="store_true",
		help="package without it — a composer with no voice input; CI's check build only",
	)
	parser.add_argument(
		"--layout-only",
		metavar="DIR",
		help="write only Resources/app into DIR, on any platform, and stop",
	)
	args = parser.parse_args()

	if args.layout_only:
		check_inputs()
		assemble_app_directory(Path(args.layout_only).resolve(), node_platform())
		print("\nlaid out.")
		return 0

	if sys.platform != "darwin":
		fail("this packages a macOS app bundle and only runs on macOS (--layout-only runs anywhere)")

	from darwin_bundle import APP_NAME, base_app, rebrand, sign

	if not args.without_whisper:
		# Before the long steps: the first build on a Mac compiles whisper.cpp
		# and downloads its model, both cached under ~/.cache/devhub/whisper.
		step("speech recogniser")
		if ensure_whisper(Path(args.whisper_dir).resolve()) != 0:
			return 1

	step("inputs")
	check_inputs()
	version = devhub_version()
	print(f"    DevHub {version}")

	out_dir = Path(args.out_dir).resolve()
	app = out_dir / f"{APP_NAME}.app"
	base = base_app()
	step(f"base bundle {base} -> {app}")
	shutil.rmtree(app, ignore_errors=True)
	out_dir.mkdir(parents=True, exist_ok=True)
	# ditto, not copytree: the Electron bundle is full of framework symlinks and
	# signed binaries, and ditto is the only copier macOS guarantees for those.
	run(["ditto", str(base), str(app)])
	# Electron's own sample app, which an app with Resources/app never loads.
	(app / "Contents" / "Resources" / "default_app.asar").unlink(missing_ok=True)

	step("bundle identity")
	rebrand(
		app,
		{"CFBundleVersion": f"{version}.{date.today():%Y%m%d}+{devhub_commit()[:10]}"},
	)
	write_licenses(app, base.parent)

	assemble_app_directory(app / "Contents" / "Resources" / "app", node_platform())

	step("speech recogniser")
	if args.without_whisper:
		print("    none: --without-whisper (this bundle's composer takes no dictation)")
	else:
		bundle_whisper(app, Path(args.whisper_dir).resolve())

	step("ad-hoc signature")
	# Ad hoc is not notarisation: the first launch of a downloaded zip still
	# needs `xattr -dr com.apple.quarantine`.
	sign(app)
	print(f"\n    {app}  {directory_size(app) / 1e6:.0f} MB")

	# Packaging does not start the app it made: scripts/smoke_packaged_app.py
	# does, and CI runs it against this bundle.

	if args.zip:
		name = args.zip_name or f"{APP_NAME}-darwin-arm64-{date.today():%Y%m%d}.zip"
		archive = out_dir / name
		archive.unlink(missing_ok=True)
		step(f"zip -> {archive}")
		try:
			argv, cwd = build_cache.zip_command(app, archive, args.zip_level)
		except ValueError as error:
			fail(str(error))
		run(argv, cwd=cwd)
		print(f"\n    {archive}  {archive.stat().st_size / 1e6:.0f} MB")

	print("\npackaged.")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
