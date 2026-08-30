#!/usr/bin/env python3
"""Assemble a runnable, unsigned DevHub.app for macOS Apple Silicon.

DevHub is not built the way VS Code is built. VS Code's own release pipeline
(`gulp vscode-darwin-arm64`) *bundles* `out/` into a handful of minified files,
and DevHub's main process imports deep module paths out of that tree
(`code-oss-dev/out/vs/platform/.../windows.js`), which the bundled build does
not have. So the packaged app ships the same unbundled `out/` compile that
`apps/desktop/scripts/dev.sh` runs against, and runs it in the same mode
(`VSCODE_DEV=1`). Packaging is therefore a *materialisation* of the developer
tree, not a different build of it: what ships is what was verified locally.

The layout inside the bundle, and why:

    DevHub.app/Contents/
      MacOS/DevHub                  VS Code's own Electron, renamed
      Frameworks/DevHub Helper*.app renamed with it — Electron finds its child
                                    processes by the main bundle's name, so the
                                    two names cannot drift apart
      Resources/DevHub.icns         rasterised from assets/icon-master.svg
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
            node_modules/           VS Code's *production* dependency closure,
                                    copied from the tree npm already built for
                                    this Electron (native modules included)

Nothing here is a symlink: a link into the developer's checkout would leave the
zip working only on the machine that made it.

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
import plistlib
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

APP_NAME = "DevHub"
BUNDLE_IDENTIFIER = "dev.devhub.app"

# The `Code - OSS` names come from VS Code's own Electron staging step
# (`npm run electron`), which renames the prebuilt Electron bundle after its
# product. Ours renames it once more.
BASE_APP = VSCODE_DIR / ".build" / "electron" / "Code - OSS.app"
BASE_PRODUCT_NAME = "Code - OSS"

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


def check_inputs() -> None:
	required = [
		(BASE_APP, "scripts/provision-vscode.sh"),
		(VSCODE_DIR / "out" / "vs" / "code" / "electron-main" / "main.js", "scripts/provision-vscode.sh"),
		(VSCODE_DIR / "node_modules" / "electron", "scripts/provision-vscode.sh"),
		(DESKTOP_DIR / "out" / "main" / "main.js", "pnpm --filter @devhub/desktop build"),
		(DESKTOP_DIR / "dist" / "shell" / "index.html", "pnpm --filter @devhub/desktop build"),
		(BRIDGE_DIR / "dist" / "extension.js", "pnpm --filter @devhub/bridge build"),
	]
	for path, command in required:
		if not path.exists():
			fail(f"missing {path}\n       produce it with: {command}")

	stamp = VSCODE_DIR / ".build" / "devhub-patches.stamp"
	patches = sorted((REPO_ROOT / "patches" / "vscode").glob("*.patch"))
	state = subprocess.run(
		["shasum"], input=b"".join(p.read_bytes() for p in patches),
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


BARE_IMPORT = re.compile(r"""(?:from|import)\s*\(?\s*["']([^."'][^"']*)["']""")

# Everything the packaged app gets from somewhere other than node_modules:
# Node's own builtins, Electron's, and the submodule, which is materialised by
# hand a few steps further down.
NOT_A_DEPENDENCY = {"electron", "original-fs", "fs", "code-oss-dev"}

# The two native modules DevHub's copy of VS Code's bootstrap imports inside
# `if (isWindows)`. They belong to VS Code, not to this app, they cannot be
# reached from the packaged `out/`, and nothing on macOS ever asks for them.
# Any *other* unresolvable import is a packaging bug and stops the build.
WINDOWS_ONLY = {"@vscode/windows-mutex", "windows-foreground-love"}

# What npm accepts as a package name; the import scan sees the odd fragment of
# a template literal, and this is what tells a name from one.
PACKAGE_NAME = re.compile(r"^(?:@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*$")

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
	specifiers: set[str] = set()
	for path in out_dir.rglob("*.js"):
		for specifier in BARE_IMPORT.findall(path.read_text(errors="ignore")):
			if specifier.startswith("node:"):
				continue
			# A deep import (`pkg/sub.js`) still means the package.
			parts = specifier.split("/")
			name = "/".join(parts[:2]) if specifier.startswith("@") else parts[0]
			if name in NOT_A_DEPENDENCY or name in WINDOWS_ONLY:
				continue
			if not PACKAGE_NAME.match(name):
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


def rename_bundle(app: Path, version: str) -> None:
	"""Make the Electron bundle DevHub's.

	Electron locates its helper processes at
	`Contents/Frameworks/<CFBundleName> Helper*.app`, so the helper bundles are
	renamed in the same pass as the plist. Renaming one without the other
	produces an app that launches and then cannot open a single window.
	"""
	contents = app / "Contents"

	executable = contents / "MacOS" / BASE_PRODUCT_NAME
	executable.rename(contents / "MacOS" / APP_NAME)

	for helper in sorted((contents / "Frameworks").glob(f"{BASE_PRODUCT_NAME} Helper*.app")):
		suffix = helper.name[len(BASE_PRODUCT_NAME):-len(".app")]  # " Helper (GPU)"
		renamed = helper.with_name(f"{APP_NAME}{suffix}.app")
		helper.rename(renamed)
		binary = renamed / "Contents" / "MacOS"
		(binary / f"{BASE_PRODUCT_NAME}{suffix}").rename(binary / f"{APP_NAME}{suffix}")
		kind = suffix[len(" Helper"):].strip("() ").lower()  # "", "gpu", "renderer"…
		patch_plist(
			renamed / "Contents" / "Info.plist",
			{
				"CFBundleExecutable": f"{APP_NAME}{suffix}",
				"CFBundleName": f"{APP_NAME}{suffix}",
				"CFBundleDisplayName": f"{APP_NAME}{suffix}",
				"CFBundleIdentifier": f"{BUNDLE_IDENTIFIER}.helper" + (f".{kind}" if kind else ""),
			},
		)

	patch_plist(
		contents / "Info.plist",
		{
			"CFBundleExecutable": APP_NAME,
			"CFBundleName": APP_NAME,
			"CFBundleDisplayName": APP_NAME,
			"CFBundleIdentifier": BUNDLE_IDENTIFIER,
			"CFBundleIconFile": f"{APP_NAME}.icns",
			"CFBundleShortVersionString": version,
			"CFBundleVersion": f"{version}.{date.today():%Y%m%d}",
		},
	)


def patch_plist(path: Path, values: dict[str, str]) -> None:
	with path.open("rb") as handle:
		plist = plistlib.load(handle)
	plist.update(values)
	with path.open("wb") as handle:
		plistlib.dump(plist, handle, fmt=plistlib.FMT_XML)


def write_icon(app: Path) -> None:
	"""Put DevHub's icon in the bundle.

	The .icns is committed rather than rendered here; scripts/package-icon.sh
	says why. Missing it is a hard error: an app whose icon quietly stayed VS
	Code's would ship looking like VS Code.
	"""
	icon = REPO_ROOT / "distribution" / f"{APP_NAME}.icns"
	if not icon.exists():
		fail(f"missing {icon}\n       produce it with: scripts/package-icon.sh")
	shutil.copyfile(icon, app / "Contents" / "Resources" / f"{APP_NAME}.icns")


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


def write_product_json(target: Path) -> None:
	"""VS Code's product metadata, saying DevHub where it says Code - OSS."""
	product = json.loads((VSCODE_DIR / "product.json").read_text())
	product.update(
		{
			"nameShort": APP_NAME,
			"nameLong": APP_NAME,
			"applicationName": "devhub",
			"dataFolderName": ".devhub",
			"sharedDataFolderName": ".devhub-shared",
			"serverDataFolderName": ".devhub-server",
			"darwinBundleIdentifier": BUNDLE_IDENTIFIER,
			"urlProtocol": "devhub",
			"win32MutexName": "devhub",
		}
	)
	target.write_text(json.dumps(product, indent="\t") + "\n")


ENTRY_SOURCE = '''\
/**
 * The packaged app's entry point.
 *
 * `apps/desktop/scripts/dev.sh` hands VS Code's Electron an environment and a
 * set of directories before it runs DevHub's main process. A double-clicked
 * app has neither a shell to set them nor arguments to carry them, so the
 * packaged bundle sets exactly the same ones here, before the first VS Code
 * module is loaded — `VSCODE_DEV` is read at module scope, so the import of
 * the real main has to come last.
 *
 * Explicit arguments still win, so a scratch run can point the app at a
 * throwaway user-data directory the way a test needs.
 *
 * Generated by scripts/package-nightly.py. Do not edit inside the bundle.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dev mode reads argv as `Electron <app location> …` and drops the first
 * argument that is not an option (`stripAppPath` in VS Code's argvHelper). A
 * double-clicked bundle has no such argument, so without this the first real
 * one is eaten instead — the value of `--user-data-dir`, or the folder someone
 * dropped on the icon. Putting the app's own location where dev mode expects
 * it makes the packaged argv the shape the code already understands.
 */
process.argv.splice(1, 0, dirname(fileURLToPath(import.meta.url)));

/** The packaged `out/` is the unbundled dev compile, so it runs in dev mode. */
process.env["VSCODE_DEV"] ??= "1";
process.env["VSCODE_CLI"] ??= "1";

/** DevHub's own state, beside the user's real VS Code state, never inside it. */
const state = join(homedir(), "Library", "Application Support", "DevHub");

for (const [flag, value] of [
\t["--user-data-dir", join(state, "user-data")],
\t["--extensions-dir", join(state, "extensions")],
]) {
\tconst given = process.argv.some(
\t\t(arg) => arg === flag || arg.startsWith(`${flag}=`),
\t);
\tif (!given) {
\t\tprocess.argv.push(flag, value);
\t}
}

await import("./out/main/main.js");
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

	step("vscode/out")
	copy_tree(VSCODE_DIR / "out", code_oss / "out", ignore=ignore_tests)
	touched, saved = strip_inline_source_maps(code_oss / "out")
	print(f"    stripped inline source maps from {touched} files ({saved / 1e6:.0f} MB)")

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
		# The Copilot extension is not part of the built-in set this app ships
		# (it is a marketplace VSIX upstream downloads at release time), and its
		# native payload is a quarter of the whole bundle.
		if "@github" in module.parts and "copilot" in module.name:
			skipped += 1
			continue
		relative = module.relative_to(VSCODE_DIR)
		copy_tree(module, code_oss / relative, ignore=lambda d, names: {"node_modules"})
	print(f"    copied the production closure, minus {skipped} Copilot packages")


# --- entry point -----------------------------------------------------------


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--out-dir", default=str(REPO_ROOT / "dist"), help="where DevHub.app is written")
	parser.add_argument("--zip", action="store_true", help="also produce a zip with ditto")
	parser.add_argument("--zip-name", default=None, help="the zip's file name")
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
	version = json.loads((DESKTOP_DIR / "package.json").read_text())["version"]
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
	rename_bundle(app, version)
	write_icon(app)
	write_licenses(app)

	assemble_app_directory(app, version, staged)

	step("ad-hoc signature")
	# An Apple Silicon Mac refuses to run a modified bundle with no signature at
	# all. Ad-hoc is not notarisation: the first launch still needs
	# `xattr -dr com.apple.quarantine`.
	run(["codesign", "--force", "--deep", "--sign", "-", str(app)])
	run(["codesign", "--verify", "--deep", "--strict", str(app)])

	print(f"\n    {app}  {directory_size(app) / 1e6:.0f} MB")

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
