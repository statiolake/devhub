#!/usr/bin/env python3
"""Build the remote extension hosts DevHub carries inside itself.

DevHub opens remote windows — on SSH hosts and in dev containers — by putting
VS Code's *server* on the far machine, starting it, and talking to it over the
connection it already has. That server is what this script builds. VS Code
calls it the REH, the remote extension host; DevHub carries four of them, one
per Linux platform it supports, and copies the one a machine needs over to it
(`apps/desktop/src/main/runtime/remoteServer.ts`). Nothing is downloaded on the
far machine or on the Mac: the servers are in the app.

    target          what it runs on                  VS Code's gulp target
    ------------    -------------------------------  ---------------------
    linux-x64       glibc Linux on x86-64            linux-x64
    linux-arm64     glibc Linux on arm64             linux-arm64
    alpine-x64      musl Linux (Alpine) on x86-64    linux-alpine
    alpine-arm64    musl Linux (Alpine) on arm64     alpine-arm64

## What it writes

Into `--out-dir` (default `dist/reh/`, which is where a source run reads them
and where `scripts/package-nightly.py` takes them from), per target:

    devhub-reh-<target>.tar.gz   one top-level directory, devhub-reh-<target>/,
                                 holding bin/<serverApplicationName>, node,
                                 out/, product.json, node_modules/
    devhub-reh-<target>.json     the statement: target, commit, identity,
                                 file, sha256, topLevelDirectory

The statement is what DevHub checks before it installs anything: the commit
and the identity must be the ones the app states (`serverCommit`,
`serverIdentity` — `scripts/product_metadata.py`), and the tarball must hash
to what the statement says. A server built before DevHub's patches moved is
refused by name rather than installed under a name that says otherwise.

## Why the identity and not only the commit

The far machine keeps the server under `~/.devhub-server/bin/<commit>-
<identity>`. The commit alone used to be the name, and it was not enough:
DevHub's servers are VS Code *plus DevHub's patches*, a patch that changes the
server does not move the commit, and every machine went on running the server
it already had. `reh_identity()` hashes the commit, every patch and the
build's own revision, so a change to any of them is a new directory.

The server's own `product.json` still states `commit` — the VS Code commit,
from `packaged_metadata()` — because that is what the server compares a
connecting client's commit with, and the packaged app states the same one.

## Native modules, per target

`vscode/remote/node_modules` holds native addons — node-pty, @parcel/watcher,
kerberos, @vscode/spdlog, sqlite3 — and the package task copies them into the
server as npm installed them. So they have to be installed *for the target*:
glibc or musl, x64 or arm64. This script does that in a container of the
target's platform (`remote_modules_image`) before packaging each target, and
puts the host's own `node_modules` back afterwards:

- glibc targets in `node:<version>-bullseye`, so the addons need no newer
  glibc than Debian 11's 2.31 — the oldest the Node they run on supports
  is 2.28, and building on a newer runner would quietly raise that floor.
- musl targets in `node:<version>-alpine`, which is what upstream does too
  (`VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME` in `build/npm/postinstall.ts`).
  The C++ runtime that musl Node needs and a stock Alpine lacks is copied in
  beside it (`bundle_musl_runtime`), so the server starts on an Alpine that has
  never run `apk add` and cannot.

The target's own Node comes from VS Code's gulp task: nodejs.org for glibc,
`node:<version>-alpine` for musl. A container of another architecture runs
under emulation (`docker run --platform`), which works and is slow; CI builds
each architecture on a runner of its own.

The Copilot built-in and its native runtime are taken back out afterwards —
about 470 MB of an 810 MB tree, and DevHub disables AI features outright. See
`remove_copilot` for why that is a deletion rather than an option passed to the
build.

Each server is then started once, offline, in a container of its platform
(`verify_server_starts`), so a server that cannot start on the machines it is
for never reaches a bundle.

## Three caches, so a rebuild is not twelve minutes

All under `~/.cache/devhub/` (`$XDG_CACHE_HOME/devhub/`), none of it secret:

- `reh/<identity>/` — the finished tarball and statement of each target. A
  target whose identity is cached is verified against its sha256 and copied
  into `--out-dir`; nothing is built, and when every target hits, the gulp
  `core-ci` bundle is skipped too. `prune_stale` cleans `dist/reh`, never this.
  `DEVHUB_REH_CACHE` moves it; `--no-cache` ignores it; `--prune-cache
  [--keep N]` drops all but the N most recently used identities (default 2).
- `reh-modules/<target>-<key>.tar` — `vscode/remote/node_modules` as `npm ci`
  left it, keyed by the target, the lock file, package.json, .npmrc, the Node
  version, the toolchain image's id and `REH_REVISION`. A patch-only change
  moves the identity but not that key, so it skips `npm ci`.
  `DEVHUB_REH_MODULES_CACHE` moves it.
- `devhub-reh-toolchain:<libc>-<arch>-<hash>` Docker images with the compilers
  (and patchelf) baked in, built on first use from the Dockerfile text in this
  file, so neither `npm ci` nor the musl bundling installs packages again.

    scripts/build_reh.py [linux-x64 linux-arm64 alpine-x64 alpine-arm64]
                         [--out-dir dist/reh] [--skip-provision] [--no-cache]
    scripts/build_reh.py --prune-cache [--keep N]

With no targets it builds all four. It needs Docker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from product_metadata import PRODUCT_OVERRIDES, REH_REVISION, packaged_metadata, reh_identity, vscode_commit

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
PRODUCT_JSON = VSCODE_DIR / "product.json"
REMOTE_DIR = VSCODE_DIR / "remote"

# Where the servers go unless told otherwise: a source run reads them here
# (`rehBundleDirectory` in apps/desktop/src/main/shell/appController.ts), and
# package-nightly.py copies them from here into the app.
DEFAULT_OUT_DIR = REPO_ROOT / "dist" / "reh"

# The four servers DevHub carries, by DevHub's name for them, and the
# (platform, arch) pair `vscode/build/gulpfile.reh.ts` names the same build
# by. `linux-alpine` is upstream's legacy spelling of the x64 musl server — it
# predates `alpine-arm64` and was kept for compatibility — and its tree is
# `vscode-reh-linux-alpine`, so the mapping is not a string rule.
GULP_TARGETS: dict[str, tuple[str, str]] = {
	"linux-x64": ("linux", "x64"),
	"linux-arm64": ("linux", "arm64"),
	"alpine-x64": ("linux", "alpine"),
	"alpine-arm64": ("alpine", "arm64"),
}
TARGETS = tuple(GULP_TARGETS)


def libc_of(target: str) -> str:
	return "musl" if target.startswith("alpine-") else "glibc"


def arch_of(target: str) -> str:
	return target.partition("-")[2]


def tarball_name(target: str) -> str:
	"""The tarball's name in the bundle — `rehTarballName` in remoteServer.ts."""
	return f"devhub-reh-{target}.tar.gz"


def statement_name(target: str) -> str:
	"""The statement beside it — `rehStatementName` in remoteServer.ts."""
	return f"devhub-reh-{target}.json"


def top_level_dir(target: str) -> str:
	"""The single directory inside the tarball — `rehTopLevelDirectory`.

	DevHub moves this one directory into place on the far machine rather than
	unpacking with `tar --strip-components`, which is not in every `tar`.
	"""
	return f"devhub-reh-{target}"


def gulp_task(target: str) -> str:
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
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	return f"vscode-reh-{gulp_platform}-{gulp_arch}-min-ci"


def staging_dir(target: str) -> Path:
	"""Where the gulp task writes the tree: the parent of the submodule.

	VS Code's build root is the parent of `vscode/`, which here is the
	repository; `.gitignore` covers `vscode-reh-*/` for that reason.
	"""
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	return REPO_ROOT / f"vscode-reh-{gulp_platform}-{gulp_arch}"


def docker_platform(target: str) -> str:
	return {"x64": "linux/amd64", "arm64": "linux/arm64"}[arch_of(target)]


def remote_node_version() -> str:
	"""The Node the server's native addons are built against: remote/.npmrc."""
	for line in (REMOTE_DIR / ".npmrc").read_text().splitlines():
		key, _, value = line.partition("=")
		if key.strip() == "target":
			return value.strip().strip('"')
	raise SystemExit(f"no target= in {REMOTE_DIR / '.npmrc'}")


def remote_modules_image(target: str, node_version: str) -> str:
	"""The stock image the toolchain image is built on.

	See the module docstring for why bullseye and why alpine.
	"""
	flavour = "alpine" if libc_of(target) == "musl" else "bullseye"
	return f"node:{node_version}-{flavour}"


def toolchain_dockerfile(target: str, node_version: str) -> str:
	"""The Dockerfile of the image `npm ci` and the musl bundling run in.

	The compilers and the kerberos headers, because `remote/.npmrc` says
	`build_from_source` — every addon is compiled against the target's Node and
	libc, none is a prebuild for some other machine — and patchelf for
	`musl_runtime_script`. Baked in once instead of installed in every
	container, which also means the musl bundling needs no network.
	"""
	base = remote_modules_image(target, node_version)
	if libc_of(target) == "musl":
		run = "apk add --no-cache python3 make g++ krb5-dev linux-headers patchelf"
	else:
		run = (
			"apt-get update -qq && apt-get install -y -qq --no-install-recommends "
			"libkrb5-dev python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*"
		)
	return f"FROM {base}\nRUN {run}\n"


def toolchain_tag(target: str, node_version: str) -> str:
	"""`devhub-reh-toolchain:<libc>-<arch>-<hash of Dockerfile + node version>`."""
	digest = hashlib.sha256(
		(toolchain_dockerfile(target, node_version) + "\0" + node_version).encode()
	).hexdigest()[:12]
	return f"devhub-reh-toolchain:{libc_of(target)}-{arch_of(target)}-{digest}"


def ensure_toolchain_image(target: str, node_version: str) -> str:
	"""The toolchain image's tag, built first if this machine has not got it."""
	tag = toolchain_tag(target, node_version)
	have = subprocess.run(["docker", "image", "inspect", tag], capture_output=True)
	if have.returncode != 0:
		print(f"  building toolchain image {tag}")
		subprocess.run(
			["docker", "build", "--platform", docker_platform(target), "-t", tag, "-"],
			input=toolchain_dockerfile(target, node_version).encode(),
			check=True,
		)
	return tag


def toolchain_image_id(tag: str) -> str:
	"""The image's content id, which is what the modules cache is keyed on."""
	result = subprocess.run(
		["docker", "image", "inspect", "--format", "{{.Id}}", tag],
		capture_output=True, text=True, check=True,
	)
	return result.stdout.strip()


def remote_modules_script(target: str) -> str:
	"""What runs in the toolchain image, in `vscode/remote`.

	`--ignore-scripts=false` is npm's default and stated only so nobody wonders.
	"""
	return "set -e; npm ci --ignore-scripts=false"


def verify_image(target: str) -> str:
	"""A plain image of the target's libc to start the finished server in.

	Not the build image: a machine DevHub installs on has no compilers and no
	Node of its own, and a server that only starts where Node is installed is a
	server that depends on something it does not carry.
	"""
	return "alpine:3" if libc_of(target) == "musl" else "debian:bullseye-slim"


def docker_available() -> bool:
	return shutil.which("docker") is not None and subprocess.run(
		["docker", "info"], capture_output=True
	).returncode == 0


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

	`stage_builtin_copilot_sdk` then checks that the compile actually left SDK
	*files* in `.build`, because on linux-arm64 it left an empty directory. See
	that function.
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


def sdk_files(sdk: Path) -> int:
	"""How many regular files the SDK tree holds, symlinks resolved.

	A directory is not the thing the build needs: it is the files under it. The
	two ways `.build` can hold a directory that carries nothing into the server
	tree are an *empty* one — `gulp.dest` writes the directory entries a
	`gulp.src('**')` yields whether or not any file survived the filters — and a
	*symlinked* one, which a glob that does not follow symlinks walks past. Both
	answer `is_dir()` and neither answers this.
	"""
	if not sdk.is_dir():
		return 0
	return sum(1 for path in sdk.rglob("*") if path.is_file())


def stage_builtin_copilot_sdk(vscode_dir: Path) -> None:
	"""Make sure `.build` carries the SDK, as real files, before packaging.

	`compile-copilot-extension-build` is supposed to put it there, by way of
	`getProductionDependencies('extensions/copilot')` — and on linux-x64 it
	does. On linux-arm64 it did not (nightlies 34701651753 and 34703272262),
	and the only thing the build then said was that a directory was missing
	from the *output* tree, 25 minutes into a job, with nothing pointing at the
	input that was actually short.

	The first version of this checked `is_dir()` and so answered the wrong
	question: in run 34703272262 it staged nothing on either architecture and
	linux-arm64 still failed, because `.build` did hold an `sdk` directory —
	one with nothing in it that the REH copy could carry. `gulp.dest` recreates
	the directory entries the source glob yields, so an SDK subtree whose files
	were all filtered out (or that npm left as a symlink into
	`@github/copilot-<os>-<arch>`, which a non-following glob walks past)
	survives into `.build` as an empty shell, and
	`gulp.src('.build/extensions/copilot/**')` then carries no file out of it
	and the server tree has no `sdk` at all. So the invariant is stated in
	files, and satisfied by copying the installed tree with its symlinks
	resolved — `copytree(symlinks=False)` reads through them, which is what
	`cp -RL` does and what packaging needs.

	Nothing here silences the assertion — the shim still runs and still throws
	if the tree is wrong. It is given the same input on both architectures
	instead of a different one.
	"""
	staged, installed = copilot_sdk_staging(vscode_dir)
	if sdk_files(staged):
		return
	if not sdk_files(installed):
		raise SystemExit(
			f"no built-in Copilot SDK files at {installed}: `npm ci` in "
			"extensions/copilot materialises them from the @github/copilot-"
			"<os>-<arch> package, and every REH package task walks into the "
			"copy of them in the server tree and fails the build when they are "
			"absent. Reprovision the submodule (scripts/provision-vscode.sh) "
			"rather than building a server whose last step cannot run."
		)
	# An empty shell left by the compile is in the way of `copytree`, and is
	# exactly what must not reach the server tree.
	shutil.rmtree(staged, ignore_errors=True)
	shutil.copytree(installed, staged, symlinks=False)
	count = sdk_files(staged)
	print(
		f"  staged the built-in Copilot SDK into {staged.parent} "
		f"({count} file{'' if count == 1 else 's'})"
	)


HOST_REMOTE_MODULES = REMOTE_DIR / "node_modules.host"


def in_container(target: str, image: str, directory: Path, script: str) -> None:
	"""Run `script` in `image`, for `target`'s platform, in `directory`.

	The directory is mounted at `/work` and is the working directory. The
	container runs as root, so whatever it wrote is handed back to whoever owns
	the checkout afterwards, or the next `npm` or `rm` here is refused.
	"""
	base = ["docker", "run", "--rm", "--platform", docker_platform(target), "-v", f"{directory}:/work", "-w", "/work"]
	# GitHub's rate limit, for the addons whose install fetches a release
	# asset; nothing else reads it.
	subprocess.run([*base, "-e", "GITHUB_TOKEN", image, "sh", "-c", script], check=True)
	if hasattr(os, "getuid") and os.getuid() != 0:
		subprocess.run(
			[*base, image, "chown", "-R", f"{os.getuid()}:{os.getgid()}", "/work"],
			check=True,
		)


# --- caches -----------------------------------------------------------------


def cache_base() -> Path:
	xdg = os.environ.get("XDG_CACHE_HOME")
	return (Path(xdg) if xdg else Path.home() / ".cache") / "devhub"


def reh_cache_root() -> Path:
	"""Finished servers, by identity. `DEVHUB_REH_CACHE` overrides."""
	override = os.environ.get("DEVHUB_REH_CACHE")
	return Path(override) if override else cache_base() / "reh"


def modules_cache_root() -> Path:
	"""`node_modules` tarballs. `DEVHUB_REH_MODULES_CACHE` overrides."""
	override = os.environ.get("DEVHUB_REH_MODULES_CACHE")
	if override:
		return Path(override)
	servers = os.environ.get("DEVHUB_REH_CACHE")
	if servers:
		return Path(servers).with_name(Path(servers).name + "-modules")
	return cache_base() / "reh-modules"


def sha256_file(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as handle:
		while chunk := handle.read(1024 * 1024):
			digest.update(chunk)
	return digest.hexdigest()


def touch(path: Path) -> None:
	try:
		os.utime(path)
	except OSError:
		pass


def cached_server_problems(cache_dir: Path, target: str, commit: str, identity: str) -> list[str]:
	"""Why `cache_dir` holds no usable `target` server; empty when it does."""
	path = cache_dir / statement_name(target)
	try:
		said = json.loads(path.read_text())
	except (OSError, ValueError):
		return [f"no statement {path}"]
	if said.get("commit") != commit or said.get("identity") != identity:
		return ["statement is for another commit or identity"]
	tarball = cache_dir / said.get("file", "")
	if said.get("file") != tarball_name(target) or not tarball.is_file():
		return [f"{tarball} is missing"]
	if sha256_file(tarball) != said.get("sha256"):
		return [f"{tarball} does not hash to its statement"]
	return []


def restore_cached_server(target: str, commit: str, identity: str, out_dir: Path, root: Path | None = None) -> bool:
	"""Copy a cached, verified `target` server into `out_dir`; False on a miss.

	An entry that fails verification is deleted so it is rebuilt, not retried.
	"""
	cache_dir = (root or reh_cache_root()) / identity
	if not (cache_dir / statement_name(target)).is_file():
		return False
	problems = cached_server_problems(cache_dir, target, commit, identity)
	if problems:
		print(f"  cached {target} server unusable ({problems[0]}); rebuilding")
		(cache_dir / statement_name(target)).unlink(missing_ok=True)
		(cache_dir / tarball_name(target)).unlink(missing_ok=True)
		return False
	out_dir.mkdir(parents=True, exist_ok=True)
	partial = out_dir / (tarball_name(target) + ".partial")
	shutil.copyfile(cache_dir / tarball_name(target), partial)
	partial.replace(out_dir / tarball_name(target))
	shutil.copyfile(cache_dir / statement_name(target), out_dir / statement_name(target))
	touch(cache_dir)
	return True


def store_cached_server(target: str, identity: str, out_dir: Path, root: Path | None = None) -> None:
	cache_dir = (root or reh_cache_root()) / identity
	cache_dir.mkdir(parents=True, exist_ok=True)
	partial = cache_dir / (tarball_name(target) + ".partial")
	shutil.copyfile(out_dir / tarball_name(target), partial)
	partial.replace(cache_dir / tarball_name(target))
	shutil.copyfile(out_dir / statement_name(target), cache_dir / statement_name(target))
	touch(cache_dir)


def prune_cache(identity: str, keep: int, root: Path | None = None, modules_root: Path | None = None) -> list[str]:
	"""Delete all but the `keep` most recently used identities, and the oldest
	module tarballs beyond `keep` * four. The current identity always stays."""
	root = root or reh_cache_root()
	modules_root = modules_root or modules_cache_root()
	removed: list[str] = []
	if root.is_dir():
		dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
		kept = {d.name for d in dirs[:max(keep, 0)]} | {identity}
		for d in dirs:
			if d.name not in kept:
				shutil.rmtree(d)
				removed.append(str(d))
	if modules_root.is_dir():
		tars = sorted(modules_root.glob("*.tar"), key=lambda f: f.stat().st_mtime, reverse=True)
		for f in tars[max(keep, 0) * len(TARGETS):]:
			f.unlink()
			removed.append(str(f))
	return removed


def modules_cache_key(
	target: str, node_version: str, image_id: str, remote_dir: Path = REMOTE_DIR, revision: int = REH_REVISION
) -> str:
	"""What `npm ci` in `vscode/remote` depends on, and nothing else.

	Files and versions only — never the environment — so `GITHUB_TOKEN` and the
	like cannot reach the key or the cache.
	"""
	def content(name: str) -> str:
		path = remote_dir / name
		return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "-"

	parts = [
		target, content("package-lock.json"), content("package.json"), content(".npmrc"),
		node_version, image_id, str(revision),
	]
	return hashlib.sha256("\0".join(parts).encode()).hexdigest()[:32]


def modules_cache_path(target: str, key: str, root: Path | None = None) -> Path:
	return (root or modules_cache_root()) / f"{target}-{key}.tar"


def install_remote_modules(target: str) -> float:
	"""Install `vscode/remote`'s dependencies for `target`, in a container.

	The host's own install is moved aside the first time and put back by
	`restore_remote_modules`, so a developer's checkout is left as provisioning
	made it. The result is cached as a tarball (`modules_cache_key`) and
	restored instead of running `npm ci` when nothing it depends on changed.
	"""
	node_modules = REMOTE_DIR / "node_modules"
	if node_modules.exists() and not HOST_REMOTE_MODULES.exists():
		node_modules.rename(HOST_REMOTE_MODULES)
	else:
		shutil.rmtree(node_modules, ignore_errors=True)
	node_version = remote_node_version()
	image = ensure_toolchain_image(target, node_version)
	cached = modules_cache_path(target, modules_cache_key(target, node_version, toolchain_image_id(image)))
	started = time.monotonic()
	if cached.is_file():
		print(f"  restoring vscode/remote modules for {target} from {cached}")
		try:
			subprocess.run(["tar", "-xf", str(cached), "-C", str(REMOTE_DIR)], check=True)
			touch(cached)
			return time.monotonic() - started
		except subprocess.CalledProcessError:
			shutil.rmtree(node_modules, ignore_errors=True)
			cached.unlink(missing_ok=True)
	print(f"  installing vscode/remote for {target} in {image}")
	in_container(target, image, REMOTE_DIR, remote_modules_script(target))
	cached.parent.mkdir(parents=True, exist_ok=True)
	partial = cached.with_name(cached.name + ".partial")
	subprocess.run(["tar", "-cf", str(partial), "-C", str(REMOTE_DIR), "node_modules"], check=True)
	partial.replace(cached)
	return time.monotonic() - started


# The C++ runtime musl's Node is linked against, which Alpine does not install
# by default: a stock `alpine` image has neither, and VS Code's own Alpine
# server simply asks for `apk add libstdc++`. A machine with no network cannot
# do that, and is exactly the machine DevHub carries its servers for.
MUSL_RUNTIME = ("/usr/lib/libstdc++.so.6", "/usr/lib/libgcc_s.so.1")


def musl_runtime_script() -> str:
	"""Copy the C++ runtime next to `node`, and point `node` at it.

	`$ORIGIN/lib` as the binary's run path: musl's loader expands `$ORIGIN`
	to the directory the executable is in, so the server's `node` finds
	`lib/libstdc++.so.6` beside itself wherever the tree is unpacked, and
	every native addon it then loads links against the copy already loaded.
	Out of the toolchain image (patchelf baked in, no network) the addons were compiled in
	and the `node` came from, so all three agree on the library's version.
	"""
	copies = " ".join(MUSL_RUNTIME)
	return (
		"set -e; mkdir -p lib; "
		f"cp -L {copies} lib/; "
		"patchelf --set-rpath '$ORIGIN/lib' node"
	)


def bundle_musl_runtime(staging: Path, target: str) -> None:
	if libc_of(target) != "musl":
		return
	in_container(target, ensure_toolchain_image(target, remote_node_version()), staging, musl_runtime_script())
	print(f"  bundled libstdc++ and libgcc_s beside {target}'s node")


def restore_remote_modules() -> None:
	"""Put the host's `vscode/remote/node_modules` back where it was."""
	if not HOST_REMOTE_MODULES.exists():
		return
	shutil.rmtree(REMOTE_DIR / "node_modules", ignore_errors=True)
	HOST_REMOTE_MODULES.rename(REMOTE_DIR / "node_modules")


# ELF `e_machine` of the binary each target's Node must be.
ELF_MACHINES = {"x64": 0x3E, "arm64": 0xB7}
MIN_NODE_BYTES = 20 * 1024 * 1024


def musl_node_dir(target: str, node_version: str) -> Path:
	"""Where VS Code's `node-<platform>-<arch>` gulp task looks for the Node.

	`vscode/build/gulpfile.reh.ts` keeps one directory per build under
	`.build/node/v<version>/` and downloads only when it is absent.
	"""
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	return VSCODE_DIR / ".build" / "node" / f"v{node_version}" / f"{gulp_platform}-{gulp_arch}"


def node_binary_problems(path: Path, target: str, node_version: str) -> list[str]:
	"""Why `path` is not the Node `node_version` for `target`; empty if it is."""
	try:
		size = path.stat().st_size
		if size < MIN_NODE_BYTES:
			return [f"{path} is only {size} bytes"]
		with path.open("rb") as handle:
			head = handle.read(20)
			if head[:4] != b"\x7fELF":
				return [f"{path} is not an ELF binary"]
			machine = int.from_bytes(head[18:20], "little")
			wanted = ELF_MACHINES[arch_of(target)]
			if machine != wanted:
				return [f"{path} is for ELF machine {machine:#x}, not {wanted:#x} ({arch_of(target)})"]
			handle.seek(0)
			needle = f"v{node_version}".encode()
			tail = b""
			while chunk := handle.read(8 * 1024 * 1024):
				if needle in tail + chunk:
					return []
				tail = chunk[-len(needle):]
	except OSError as error:
		return [str(error)]
	return [f"{path} does not say it is Node v{node_version}"]


def fetch_musl_node(target: str, node_version: str) -> Path:
	"""Put the musl Node for `target` where VS Code's build will find it.

	Upstream gets it by `execSync("docker run ... cat node")`, whose output
	buffer is too small for a Node 24 binary (ENOBUFS), and without `--platform`
	(an arm64 host pulls the wrong image for alpine-x64). nodejs.org has no
	official musl build and no checksum for it, so there is nothing else to
	trust. Here the container's stdout goes straight to a file, for the target's
	platform, and the file is checked before it is put in place.
	"""
	directory = musl_node_dir(target, node_version)
	existing = directory / "node"
	if existing.is_file() and not node_binary_problems(existing, target, node_version):
		return existing
	shutil.rmtree(directory, ignore_errors=True)
	partial = directory.with_name(directory.name + ".partial")
	shutil.rmtree(partial, ignore_errors=True)
	partial.mkdir(parents=True)
	image = remote_modules_image(target, node_version)
	print(f"  fetching node {node_version} for {target} from {image}")
	with (partial / "node").open("wb") as out:
		subprocess.run(
			["docker", "run", "--rm", "--platform", docker_platform(target), image, "cat", "/usr/local/bin/node"],
			stdout=out,
			check=True,
		)
	problems = node_binary_problems(partial / "node", target, node_version)
	if problems:
		shutil.rmtree(partial, ignore_errors=True)
		raise SystemExit(f"the node from {image} for {target} is wrong: {problems[0]}")
	(partial / "node").chmod(0o755)
	partial.rename(directory)
	return directory / "node"


def missing_targets(out_dir: Path, targets: tuple[str, ...] | list[str], commit: str, identity: str) -> list[str]:
	"""The `targets` that have no current server in `out_dir`."""
	return [t for t in targets if bundle_problems(out_dir, commit, identity, required=(t,))]


def retry_command(out_dir: Path, targets: tuple[str, ...] | list[str], commit: str, identity: str) -> str:
	"""The command that builds only what is still missing; built ones stay."""
	todo = missing_targets(out_dir, targets, commit, identity)
	return "scripts/build_reh.py " + " ".join(todo or targets)


def build_target(target: str, commit: str, identity: str, out_dir: Path) -> Path:
	"""Install, package, trim, verify and tar one target, and state it."""
	staging = staging_dir(target)
	elapsed = install_remote_modules(target)
	if libc_of(target) == "musl":
		fetch_musl_node(target, remote_node_version())
	elapsed += gulp(gulp_task(target), commit)

	if not staging.is_dir():
		raise SystemExit(f"{gulp_task(target)} produced no {staging}")

	remove_copilot(staging, target)
	bundle_musl_runtime(staging, target)
	verify_server_starts(staging, target)

	tarball = out_dir / tarball_name(target)
	pack(staging, tarball, top_level_dir(target))
	write_statement(out_dir, target, commit, identity)
	store_cached_server(target, identity, out_dir)
	size_mb = tarball.stat().st_size / 1e6
	print(f"{tarball.name}: {size_mb:.0f} MB, built in {elapsed / 60:.0f} min")
	return tarball


def statement(target: str, commit: str, identity: str, tarball: Path) -> dict[str, str]:
	"""What DevHub reads before it installs this server — see the docstring."""
	return {
		"target": target,
		"commit": commit,
		"identity": identity,
		"file": tarball.name,
		"sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
		"topLevelDirectory": top_level_dir(target),
	}


def write_statement(out_dir: Path, target: str, commit: str, identity: str) -> Path:
	path = out_dir / statement_name(target)
	path.write_text(
		json.dumps(statement(target, commit, identity, out_dir / tarball_name(target)), indent="\t")
		+ "\n"
	)
	return path


def read_statements(directory: Path) -> dict[str, dict[str, str]]:
	"""Every statement in a bundle directory, by target."""
	found: dict[str, dict[str, str]] = {}
	for target in TARGETS:
		path = directory / statement_name(target)
		if path.is_file():
			found[target] = json.loads(path.read_text())
	return found


def bundle_problems(
	directory: Path, commit: str, identity: str, required: tuple[str, ...] = TARGETS
) -> list[str]:
	"""Why this directory is not the set of servers a DevHub of `commit` and
	`identity` carries — nothing, when it is.

	Asked by `scripts/package-nightly.py` before it copies the servers into the
	app, so a bundle that would refuse a machine at runtime is refused at
	packaging instead, where the person who can fix it is looking.
	"""
	problems: list[str] = []
	statements = read_statements(directory)
	for target in required:
		said = statements.get(target)
		if said is None:
			problems.append(
				f"no {target} server in {directory} (scripts/build_reh.py {target})"
			)
			continue
		if said.get("commit") != commit or said.get("identity") != identity:
			problems.append(
				f"the {target} server in {directory} was built from VS Code "
				f"{said.get('commit')} with identity {said.get('identity')}, and this "
				f"DevHub is {commit} with {identity}: rebuild it "
				f"(scripts/build_reh.py {target})"
			)
			continue
		tarball = directory / said.get("file", "")
		if not tarball.is_file():
			problems.append(f"{tarball} is missing although {statement_name(target)} names it")
			continue
		digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
		if digest != said.get("sha256"):
			problems.append(f"{tarball} hashes to {digest}, not the {said.get('sha256')} it states")
	return problems


def prune_stale(out_dir: Path, identity: str) -> list[str]:
	"""Take away servers built from another identity than this checkout's.

	A bundle directory that held servers of two identities would be a bundle
	half of whose machines DevHub refuses; a developer who rebuilt one target
	after moving a patch would find the others refused at runtime with a
	sentence about something they did not touch. So the old ones go, and are
	named, when the first new one is built.
	"""
	removed: list[str] = []
	for target, said in read_statements(out_dir).items():
		if said.get("identity") == identity:
			continue
		(out_dir / statement_name(target)).unlink(missing_ok=True)
		(out_dir / tarball_name(target)).unlink(missing_ok=True)
		removed.append(target)
	return removed


# The `@github/copilot-<platform>-<arch>` runtime package, by the name
# `build/lib/copilot.ts` computes for it. Only the target's own is in the tree
# — `getCopilotExcludeFilter` has already stripped the others — so a glob finds
# the one there is without this script having to reproduce that naming.
COPILOT_RUNTIME_GLOB = "node_modules/@github/copilot-*-*"

# What stays: 12 KB of loader and 736 KB of SDK. `server-main.js` reads both
# their `package.json` versions at startup to fill in `product.copilotVersions`
# — it tolerates their absence, but there is no reason to make it.
COPILOT_KEPT = ("node_modules/@github/copilot", "node_modules/@github/copilot-sdk")


def remove_copilot(staging: Path, target: str) -> None:
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
	doomed = [staging / "extensions" / "copilot", *staging.glob(COPILOT_RUNTIME_GLOB)]
	removed = 0
	for path in doomed:
		if not path.exists():
			continue
		removed += sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
		shutil.rmtree(path)

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
	print(f"  removed {removed / 1e6:.0f} MB of Copilot ({target})")


def verify_server_starts(staging: Path, target: str) -> None:
	"""Start the server that was just carved up, offline, where it will run.

	In a plain container of the target's libc and architecture with no network
	(`--network none`): no compilers, no Node, no route out — the machine this
	server is for, as far as starting it is concerned. `--version` loads
	`server-main.js`, which is where the product metadata, the
	`copilotVersions` lookup and the module resolution that `remove_copilot`
	could plausibly have broken all happen, and it runs the target's own `node`
	on the target's own libc, which is the thing a wrong build gets wrong.

	Without Docker it falls back to running it here, when this machine is the
	target; anything else is said rather than skipped silently.
	"""
	launcher = f"bin/{PRODUCT_OVERRIDES['serverApplicationName']}"
	if docker_available():
		argv = [
			"docker", "run", "--rm", "--network", "none",
			"--platform", docker_platform(target),
			"-v", f"{staging}:/reh:ro",
			verify_image(target),
			f"/reh/{launcher}", "--version",
		]
	elif runs_here(target):
		argv = [str(staging / launcher), "--version"]
	else:
		print(f"  NOT VERIFIED: no Docker to start the {target} server in")
		return
	result = subprocess.run(argv, capture_output=True, text=True, timeout=300)
	if result.returncode != 0:
		raise SystemExit(
			f"the {target} server did not start ({' '.join(argv)} exited "
			f"{result.returncode}):\n{result.stdout}{result.stderr}"
		)
	print(f"  {target} {launcher} --version: {result.stdout.strip().splitlines()[0]}")


def runs_here(target: str) -> bool:
	"""Whether this machine can execute `target`'s server itself."""
	if platform.system() != "Linux":
		return False
	machine = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
	here_musl = Path("/etc/alpine-release").exists()
	return (arch_of(target), libc_of(target) == "musl") == (machine, here_musl)


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
	parser.add_argument("targets", nargs="*", help=f"any of {', '.join(TARGETS)}; default: all four")
	parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
	parser.add_argument("--no-cache", action="store_true", help="build even targets the cache has")
	parser.add_argument("--prune-cache", action="store_true", help="clean the caches and exit")
	parser.add_argument("--keep", type=int, default=2, help="with --prune-cache: identities to keep (default 2)")
	parser.add_argument(
		"--skip-provision",
		action="store_true",
		help="the tree is already provisioned (CI does this step itself)",
	)
	args = parser.parse_args()
	if args.prune_cache:
		for gone in prune_cache(reh_identity(), args.keep):
			print(f"removed {gone}")
		return 0
	targets = args.targets or list(TARGETS)
	unknown = [target for target in targets if target not in TARGETS]
	if unknown:
		parser.error(f"no such target: {', '.join(unknown)} (DevHub carries {', '.join(TARGETS)})")

	if not docker_available():
		raise SystemExit(
			"build_reh.py needs Docker: each server's native modules are installed "
			"in a container of its platform, and each server is started in one "
			"before it is packed. Start Docker (Docker Desktop, colima, or dockerd) "
			"and run this again."
		)

	if not args.skip_provision:
		subprocess.run([str(REPO_ROOT / "scripts" / "provision-vscode.sh")], check=True)

	commit = vscode_commit()
	identity = reh_identity()
	out_dir: Path = args.out_dir.resolve()
	out_dir.mkdir(parents=True, exist_ok=True)
	print(f"remote extension hosts for VS Code {commit}, identity {identity}: {', '.join(targets)}")
	for target in prune_stale(out_dir, identity):
		print(f"  removed the {target} server built from another identity")

	if not args.no_cache:
		cached = [t for t in targets if restore_cached_server(t, commit, identity, out_dir)]
		for target in cached:
			print(f"  {target}: restored from {reh_cache_root() / identity}")
		targets = [t for t in targets if t not in cached]
		if not targets:
			return 0

	original_product_json = write_devhub_product_json()
	try:
		print(f"bundled the server sources in {bundle_server_sources(commit) / 60:.0f} min")
		for target in targets:
			try:
				build_target(target, commit, identity, out_dir)
			except (subprocess.CalledProcessError, SystemExit) as error:
				remaining = retry_command(out_dir, targets, commit, identity)
				print(
					f"\nerror: building {target} failed ({error}).\n"
					f"Servers already built stay in {out_dir}. Retry only what is missing with:\n"
					f"  {remaining}",
					file=sys.stderr,
				)
				return 1
	finally:
		# Put the submodule's own file back. Leaving DevHub's there would be a
		# trap for `pnpm dev`: the merged metadata carries `commit`, and a
		# source run that states one loses syntax highlighting and the terminal
		# to a `node_modules.asar` it does not have. See
		# scripts/product_metadata.py.
		PRODUCT_JSON.write_text(original_product_json)
		restore_remote_modules()

	return 0


if __name__ == "__main__":
	sys.exit(main())
