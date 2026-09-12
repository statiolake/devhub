#!/usr/bin/env python3
"""Build the Remote Extension Host — the half of DevHub that runs over SSH.

DevHub connects to a remote machine the way VSCodium does: the client asks the
Open Remote - SSH extension to open a host, the extension downloads a *server*
tarball onto that host, unpacks it and starts it, and the workbench then talks
to it over the SSH tunnel. That tarball is what this script builds. VS Code
calls it the REH, the remote extension host; the file people see is
`devhub-reh-linux-x64-<commit>.tar.gz`.

## The contract with the extension

The extension's install script is generated from `src/scripts/server-setup.sh`
in jeanp413/open-remote-ssh, and every name below is something that script
reads out of DevHub's `product.json` and then expects to find inside the
tarball. Nothing here is a preference:

    product.json key            what the remote does with it
    ------------------------    -----------------------------------------
    serverDownloadUrlTemplate   the URL to fetch, after substituting
                                ${quality} ${version} ${commit} ${os}
                                ${arch} ${release} — those six, by `sed`,
                                and no others
    commit                      names the install directory
                                ($HOME/<serverDataFolderName>/bin/<commit>)
                                *and* is what the server checks the
                                connecting client's commit against
    serverApplicationName       the script it runs: bin/<serverApplicationName>
    serverDataFolderName        where on the remote all of it lives
    version                     substituted into the URL as ${version}; the
                                client sends its own `vscode.version`

The tarball is unpacked with `tar --strip-components 1`, so it must have
exactly one top-level directory, and under it `bin/<serverApplicationName>`,
`node`, `out/` and `product.json` — the launcher script resolves the other
three relative to itself.

`${quality}` and `${release}` are deliberately absent from DevHub's template.
DevHub states neither key, and the extension substitutes a missing one with the
string `undefined` (PowerShell) or the empty string (sh) rather than failing —
a URL that is wrong in a way no error message mentions. What is left is
`${os}`, `${arch}` and `${commit}`, all three of which DevHub does state.

## Why `commit` is the whole design

`product.commit` is the VS Code submodule's HEAD; `scripts/product_metadata.py`
explains why it is that and not DevHub's own hash. The remote server refuses a
client whose commit differs from its own — that is `serverValidation: strict`,
the extension's default — so the REH's `product.json` and the packaged app's
`product.json` have to state the same forty characters. They do, because both
come from `packaged_metadata()`.

That is also why the release tag is keyed on the VS Code commit rather than on
a date or on DevHub's own commit: the REH is a function of the submodule, the
URL can only be parameterised by what the six placeholders offer, and `${commit}`
is the one of them that identifies a build. A DevHub commit that does not move
the submodule needs no new REH, and the nightly therefore skips this entirely on
most nights. See .github/workflows/nightly.yml.

The corollary, and the one sharp edge: a change to `patches/vscode/` that
touches server code does *not* change `commit`, so it does not change the URL
and the remote goes on using the REH already published for that submodule
commit. Rebuild it deliberately (Actions -> Nightly -> Run workflow with
`force_reh`) when that happens.

## What the build needs

A provisioned submodule — `scripts/provision-vscode.sh`, which this script runs
for you. The gulp task compiles VS Code's sources for the server, downloads the
prebuilt Node for the *target* platform from nodejs.org, and writes the tree to
`<repo root>/vscode-reh-<os>-<arch>` (VS Code's build root is the parent of the
submodule, which for DevHub is the repository itself; both are gitignored).

Cross-building mostly works but is not shippable: the Node comes down for the
target, but `vscode/remote/node_modules` holds native addons the package task
copies as npm installed them, for the host. So each published target is built
on a runner of its own architecture.

The Copilot built-in and its native runtime are taken back out afterwards —
about 470 MB of an 810 MB tree, and DevHub disables AI features outright. See
`remove_copilot` for why that is a deletion rather than an option passed to the
build.

    scripts/build_reh.py linux-x64 linux-arm64 [--out-dir dist] [--skip-provision]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from product_metadata import PRODUCT_OVERRIDES, packaged_metadata, vscode_commit

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
PRODUCT_JSON = VSCODE_DIR / "product.json"

# Which targets DevHub publishes. `vscode/build/gulpfile.reh.ts` can build more
# (win32, alpine, ppc64le...), but a target nobody has is a target nobody
# notices is broken, and each one is a download and a few minutes of a runner.
#
# linux-x64 and linux-arm64 are what people SSH into, and they are what the
# nightly publishes. darwin-arm64 is buildable but not published: the native
# addons in `vscode/remote/node_modules` are the host's, so it is only correct
# when built on a Mac, and the one job DevHub has on a Mac already runs for two
# hours against a two-hour timeout. It stays here because a developer with a
# Mac to SSH into can build and install one by hand; see docs/remote-ssh.md.
TARGETS = ("linux-x64", "linux-arm64", "darwin-arm64")


def tarball_name(os_name: str, arch: str, commit: str) -> str:
	"""What `serverDownloadUrlTemplate` resolves to for this target.

	The three placeholders in the template are the three arguments here, so
	this function and the template in
	`apps/desktop/product-overrides.json` are the same statement written twice
	— which is what `build_reh_test.py` checks.
	"""
	return f"devhub-reh-{os_name}-{arch}-{commit}.tar.gz"


def release_tag(commit: str) -> str:
	"""The GitHub release that holds the tarballs for this VS Code commit.

	Not the rolling `nightly` tag. That release is replaced whole every night,
	and a client older than the newest nightly would find its server gone —
	whereas the REH itself changes only when the submodule does. One immutable
	release per submodule commit, referenced by a template that already has
	`${commit}` in it, means yesterday's app keeps connecting.
	"""
	return f"reh-{commit}"


def top_level_dir(os_name: str, arch: str) -> str:
	"""The single directory inside the tarball.

	`tar --strip-components 1` in the extension's install script requires
	exactly one, and does not care what it is called.
	"""
	return f"devhub-reh-{os_name}-{arch}"


def gulp_task(os_name: str, arch: str) -> str:
	"""VS Code's own name for the task that assembles this target's tree.

	`-min` is the bundled-and-minified server, which is what a download should
	be. `-ci` is the half of that task which only *packages*: it takes
	`out-vscode-reh-min` as it finds it, adds the extensions, the production
	node_modules, the target's Node and the launcher scripts, and writes the
	tree. The other half — the one the plain `vscode-reh-<os>-<arch>-min` task
	runs first — is `compile-build-with-mangling`, and it does not complete on
	1.136.1: upstream's own `sessionChangesEditor.ts` widens three protected
	members of the base toggle and action-bar view items, and the mangler
	refuses ("Protected fields have been made PUBLIC") rather than emit code it
	cannot shrink.

	`core-ci` is the path around it, and not a workaround invented here: it is
	the task upstream's own CI runs, it transpiles with esbuild instead, and
	`scripts/provision-vscode.sh` already uses it for the same reason. Among
	the three trees it bundles in parallel is `out-vscode-reh-min` — the exact
	input this task wants. See `bundle_server_sources`.
	"""
	return f"vscode-reh-{os_name}-{arch}-min-ci"


def toolchain_node_bin() -> Path:
	"""The Node `scripts/provision-vscode.sh` fetched for VS Code's build.

	VS Code's build refuses any other version, and the machine's own Node is
	not it. The provisioning script puts exactly one matching directory in
	`vscode-toolchain/`; finding it here rather than recomputing the name keeps
	the two scripts from disagreeing about the platform triple.
	"""
	version = (VSCODE_DIR / ".nvmrc").read_text().strip()
	candidates = sorted((REPO_ROOT / "vscode-toolchain").glob(f"node-v{version}-*/bin"))
	if not candidates:
		raise SystemExit(
			f"no Node {version} in vscode-toolchain/ — run scripts/provision-vscode.sh"
		)
	return candidates[0]


def write_devhub_product_json() -> str:
	"""Say DevHub inside the server tarball, and return what was there before.

	The REH build reads `vscode/product.json` at build time — for
	`serverApplicationName`, which becomes the name of the launcher script, and
	for the copy `inlineMeta` bakes into the bundled entry points — so the
	packaged app's trick of writing the merged product.json afterwards does not
	work here. It has to be true before gulp starts, which means editing the
	submodule's own file and putting it back. VSCodium does the same thing for
	the same reason.

	`commit` comes from `packaged_metadata()`, so the server states exactly the
	forty characters the packaged client states.
	"""
	original = PRODUCT_JSON.read_text()
	product = json.loads(original)
	product.update(packaged_metadata())
	PRODUCT_JSON.write_text(json.dumps(product, indent="\t") + "\n")
	return original


def gulp(task: str, commit: str, extra_env: dict[str, str] | None = None) -> float:
	"""Run one of VS Code's build tasks, and say how long it took."""
	env = dict(os.environ)
	env.update(extra_env or {})
	env["PATH"] = f"{toolchain_node_bin()}{os.pathsep}{env['PATH']}"
	# `build/lib/getVersion.ts` reads `<repo>/.git/HEAD` as a file. In a
	# submodule `.git` *is* a file, so that read fails and the build stamps
	# `commit: undefined` into the server's product.json — which the remote
	# would then install under a directory called "undefined" and refuse every
	# client. This is upstream's own override for the case where the checkout
	# cannot answer, and it is the same hash `packaged_metadata()` uses.
	env["BUILD_SOURCEVERSION"] = commit

	started = time.monotonic()
	subprocess.run(["npm", "run", "gulp", "--", task], cwd=VSCODE_DIR, env=env, check=True)
	return time.monotonic() - started


def bundle_server_sources(commit: str) -> float:
	"""Bundle `out-vscode-reh-min`, the tree the package tasks copy in as `out/`.

	One run serves every target: nothing in it is per-platform. It also rebuilds
	`out-vscode-min` and `out-vscode-reh-web-min` alongside, because `core-ci`
	makes the three in parallel and there is no upstream task for one of them —
	which is a minute or two, not a reason to invent one.

	It has to run inside the window where `vscode/product.json` says DevHub:
	esbuild inlines `product.json` into the bundles, so a tree bundled against
	the submodule's own file carries `code-server-oss` in `server-main.js` no
	matter what the `product.json` beside it says afterwards.

	`compile-copilot-extension-build` follows because `core-ci` does not do it
	and the package task's last step, `prepareCopilotRipgrepShimTaskREH`, walks
	into `extensions/copilot/node_modules/@github/copilot/sdk` and fails the
	build when it is not there. In the full `vscode-reh-...-min` task that
	compile is one of the steps the mangling half runs; it is one of the things
	going around that half loses.

	`stage_builtin_copilot_sdk` then checks that the compile actually left the
	SDK in `.build`, because on linux-arm64 it did not. See that function.
	"""
	elapsed = gulp("core-ci", commit)
	# `VSCODE_QUALITY` because that compile refuses to run on a machine with
	# `CI` set — every runner, and this session's shell — without being told
	# which channel it is building for: it stamps a date-based pre-release
	# version into the extension's package.json for anything but `stable`, and
	# will not guess. `stable` is what DevHub means; it publishes one channel
	# and ships the extension at the version the submodule pins. The variable
	# reaches nothing else here — `product.json` still states no `quality`, and
	# the server's version suffix is read from there, not from the environment.
	elapsed += gulp("compile-copilot-extension-build", commit, {"VSCODE_QUALITY": "stable"})
	stage_builtin_copilot_sdk(VSCODE_DIR)
	return elapsed


# Where the built-in Copilot extension's CLI SDK lives, relative to the
# submodule and relative to `.build`. Both spellings are the same path because
# `packageCopilotExtensionStream` writes the extension's production
# dependencies into `.build` under the path they have in the checkout.
BUILT_IN_COPILOT_SDK = Path("extensions/copilot/node_modules/@github/copilot/sdk")


def copilot_sdk_staging(vscode_dir: Path) -> tuple[Path, Path]:
	"""The SDK the REH package task reads, and the one npm installed.

	The first is what `prepareCopilotRipgrepShimTaskREH` ends up asserting on:
	the package task copies `.build/extensions/copilot/**` into the server tree,
	and the shim step then walks into `<tree>/extensions/copilot/node_modules/
	@github/copilot/sdk` and throws when it is not there. The second is where
	`extensions/copilot`'s own postinstall materialises it, out of the
	`@github/copilot-<os>-<arch>` package npm chose for the machine — the base
	`@github/copilot` tarball ships two files and nothing else.
	"""
	return vscode_dir / ".build" / BUILT_IN_COPILOT_SDK, vscode_dir / BUILT_IN_COPILOT_SDK


def stage_builtin_copilot_sdk(vscode_dir: Path) -> None:
	"""Make sure `.build` carries the SDK before a REH package task runs.

	`compile-copilot-extension-build` is supposed to put it there, by way of
	`getProductionDependencies('extensions/copilot')` — and on linux-x64 it
	does. On linux-arm64 it did not (nightly 34701651753), and the only thing
	the build then said was that a directory was missing from the *output*
	tree, 25 minutes into a job, with nothing pointing at the input that was
	actually short. Which of the arch-dependent steps between npm and gulp drops
	it is upstream's business; what this script can do is state the invariant
	the REH task depends on, satisfy it from the copy npm installed, and stop
	with the real name of the missing thing when there is no such copy.

	Nothing here silences the assertion — the shim still runs and still throws
	if the tree is wrong. It is given the same input on both architectures
	instead of a different one.
	"""
	staged, installed = copilot_sdk_staging(vscode_dir)
	if staged.is_dir():
		return
	if not installed.is_dir():
		raise SystemExit(
			f"no built-in Copilot SDK at {installed}: `npm ci` in "
			"extensions/copilot materialises it from the @github/copilot-<os>-"
			"<arch> package, and every REH package task walks into the copy of "
			"it in the server tree and fails the build when it is absent. "
			"Reprovision the submodule (scripts/provision-vscode.sh) rather "
			"than building a server whose last step cannot run."
		)
	shutil.copytree(installed, staged)
	print(f"  staged the built-in Copilot SDK into {staged.parent}")


def build_target(os_name: str, arch: str, commit: str, out_dir: Path) -> Path:
	"""Package one target's tree out of the bundle, and tar it."""
	# VS Code's build root is the parent of the submodule, which here is the
	# repository. `.gitignore` covers `vscode-reh-*/` for that reason.
	staging = REPO_ROOT / f"vscode-reh-{os_name}-{arch}"

	elapsed = gulp(gulp_task(os_name, arch), commit)

	if not staging.is_dir():
		raise SystemExit(f"{gulp_task(os_name, arch)} produced no {staging}")

	remove_copilot(staging, os_name, arch)
	if runs_here(os_name, arch):
		verify_server_starts(staging)

	tarball = out_dir / tarball_name(os_name, arch, commit)
	pack(staging, tarball, top_level_dir(os_name, arch))
	size_mb = tarball.stat().st_size / 1e6
	print(f"{tarball.name}: {size_mb:.0f} MB, packaged in {elapsed:.0f}s")
	return tarball


# The `@github/copilot-<platform>-<arch>` runtime package, by the name
# `build/lib/copilot.ts` computes for it. Only the target's own is in the tree
# — `getCopilotExcludeFilter` has already stripped the others — so a glob finds
# the one there is without this script having to reproduce that naming.
COPILOT_RUNTIME_GLOB = "node_modules/@github/copilot-*-*"

# What stays: 12 KB of loader and 736 KB of SDK. `server-main.js` reads both
# their `package.json` versions at startup to fill in `product.copilotVersions`
# — it tolerates their absence, but there is no reason to make it.
COPILOT_KEPT = ("node_modules/@github/copilot", "node_modules/@github/copilot-sdk")


def remove_copilot(staging: Path, os_name: str, arch: str) -> None:
	"""Take the Copilot built-in and its native runtime back out of the server.

	DevHub pins `chat.disableAIFeatures: true` — fixed, not a preference — so
	nothing on the remote will ever start the agent host, and what is being
	deleted is about 470 MB of an 810 MB tree: ~305 MB of built-in extension
	and ~185 MB of platform runtime, most of it one native binary shipped
	twice. The tarball goes from 237 MB to 103 MB. Over an SSH connection to a
	machine being set up for the first time, that is the difference between a
	wait and a decision.

	This is a deletion after the fact, which is the worse of the two ways to do
	it, and it is here because the better one does not exist upstream.
	`packageTask` takes its built-in list from a glob over the submodule's own
	`extensions/*/package.json` — `copilot` is a local workspace extension, not
	an entry in `product.json`'s `builtInExtensions`, so the product edit this
	script already makes cannot reach it — and there is no environment variable
	or flag that turns it off. Nor can the extension simply be left uncompiled:
	the last step of every REH package task is `prepareCopilotRipgrepShimTaskREH`,
	which walks into the *output* directory and throws when the SDK is not
	there. Both routes end at the same wall, so the build makes the whole thing
	and this takes half of it away again.

	What it must not break is startup, which is why `verify_server_starts`
	exists and why the two small packages above are kept.
	"""
	targets = [staging / "extensions" / "copilot", *staging.glob(COPILOT_RUNTIME_GLOB)]
	removed = 0
	for target in targets:
		if not target.exists():
			continue
		removed += sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
		shutil.rmtree(target)

	# A build that stopped shipping Copilot for some *other* reason — upstream
	# renaming the package, say — would silently produce a smaller tarball and
	# tell nobody, and the next person to wonder where the agent host went
	# would have no thread to pull. So say what was found, and refuse the
	# silence.
	if removed == 0:
		raise SystemExit(
			f"no Copilot to remove from {staging}: expected extensions/copilot and "
			f"{COPILOT_RUNTIME_GLOB}, found neither. Upstream has moved; read "
			"vscode/build/lib/copilot.ts and fix remove_copilot rather than "
			"shipping a server that quietly differs from the one before it."
		)
	print(f"  removed {removed / 1e6:.0f} MB of Copilot ({os_name}-{arch})")


def verify_server_starts(staging: Path) -> None:
	"""Run the server that was just carved up, and make it say something.

	Only for a target this machine can execute — the Node in a cross-built
	tarball is the target's. It is a weak check on purpose: `--version` loads
	`server-main.js`, which is where the product metadata, the
	`copilotVersions` lookup and the module resolution that `remove_copilot`
	could plausibly have broken all happen. A failure here means the deletion
	took something the server needed, which is the one thing worth catching
	before the tarball leaves the machine.
	"""
	launcher = staging / "bin" / PRODUCT_OVERRIDES["serverApplicationName"]
	result = subprocess.run(
		[str(launcher), "--version"], capture_output=True, text=True, timeout=120
	)
	if result.returncode != 0:
		raise SystemExit(
			f"{launcher} --version exited {result.returncode} after remove_copilot:\n"
			f"{result.stdout}{result.stderr}"
		)
	print(f"  {launcher.name} --version: {result.stdout.strip().splitlines()[0]}")


def runs_here(os_name: str, arch: str) -> bool:
	"""Whether this machine can execute the server it just built."""
	here = {"darwin": "darwin", "linux": "linux"}.get(platform.system().lower())
	machine = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
	return (os_name, arch) == (here, machine)


def pack(staging: Path, tarball: Path, top_level: str) -> None:
	"""Gzip the tree under a single top-level directory.

	Written by hand rather than shelled out to `tar` because the executable
	bits gulp set — on `node`, on `bin/<serverApplicationName>`, on the
	helpers — are the difference between a server that starts and one that
	reports "server contents are corrupted", and Python's tarfile carries the
	mode straight from the file it read.
	"""
	tarball.parent.mkdir(parents=True, exist_ok=True)
	if tarball.exists():
		tarball.unlink()
	with tarfile.open(tarball, "w:gz") as archive:
		archive.add(staging, arcname=top_level)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("targets", nargs="+", choices=TARGETS)
	parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "dist")
	parser.add_argument(
		"--skip-provision",
		action="store_true",
		help="the tree is already provisioned (CI does this step itself)",
	)
	args = parser.parse_args()

	if not args.skip_provision:
		subprocess.run([str(REPO_ROOT / "scripts" / "provision-vscode.sh")], check=True)

	commit = vscode_commit()
	print(f"REH for VS Code {commit}, release {release_tag(commit)}")

	original_product_json = write_devhub_product_json()
	try:
		print(f"bundled the server sources in {bundle_server_sources(commit) / 60:.0f} min")
		for target in args.targets:
			os_name, _, arch = target.partition("-")
			build_target(os_name, arch, commit, args.out_dir)
	finally:
		# Put the submodule's own file back. Leaving DevHub's there would be a
		# trap for `pnpm dev`: the merged metadata carries `commit`, and a
		# source run that states one loses syntax highlighting and the terminal
		# to a `node_modules.asar` it does not have. See
		# scripts/product_metadata.py.
		PRODUCT_JSON.write_text(original_product_json)

	return 0


if __name__ == "__main__":
	sys.exit(main())
