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
it already had. `reh_identity()` hashes the commit, every patch and overlay file and
the build's own revision, so a change to any of them is a new directory.

The server's own `product.json` still states `commit` — the VS Code commit,
from `packaged_metadata()` — because that is what the server compares a
connecting client's commit with, and the packaged app states the same one.

## Built on Linux, the way VS Code builds its own

The whole server is built in Linux containers, on a copy of the pinned VS Code
of its own — never in the developer's `vscode/` checkout, whose node_modules
are the Mac's. That is how upstream builds it: on a Linux x64 agent, every
architecture, `npm ci` at the root with the target's `npm_config_arch` and
`build/azure-pipelines/linux/setup-env.sh`'s toolchain (VS Code's glibc 2.28
sysroots, `VSCODE_REMOTE_CC`/`CXX` for `remote/`), then `gulp core-ci` and
`gulp vscode-reh-<platform>-<arch>-min-ci`. Of `core-ci` the tree runs the
part a server is made of (`core_ci_server` in the script: the extension
builds and the server bundle, not the desktop and web bundles, which peak past
14 GB together and which no server carries). Gulp on the Mac put the Mac's
natives into the Linux servers (the MSAL broker runtime, git's
`@vscode/fs-copyfile`), and every patch-up after the fact missed the next one.
Built on Linux there is nothing to patch up: every native in the tree was
built for, or picked by npm for, the target.

`scripts/reh_in_container.sh` holds the steps, in upstream's order, with the
pipeline files they come from. This script runs them and owns everything
around them:

    per architecture   prepare     the builder image (`builder_dockerfile`:
                                   ubuntu:22.04, upstream's agent, linux/amd64
                                   always — the sysroot compilers are x86-64
                                   programs and upstream cross-builds arm64);
                                   the tree in the Docker volume
                                   `devhub-reh-work-<arch>`: the pinned commit,
                                   DevHub's patches and product.json, `npm ci`,
                                   `core-ci`, the Copilot compile
    per musl target    musl-remote `remote/` installed again in
                                   `node:<version>-alpine` of the target's
                                   platform, as upstream's Alpine pipeline does
                                   in its own Alpine container, and that image's
                                   `node` put where the gulp task looks
    per target         package     `vscode-reh-<platform>-<arch>-min-ci`,
                                   tarred out to the host
                       (host)      `remove_copilot`, `drop_glibc_msal_runtime`
                                   (musl), `bundle_musl_runtime` (musl),
                                   `refuse_foreign_binaries`,
                                   `verify_glibc_floor` (glibc; upstream's
                                   verify-glibc-requirements.sh in the builder),
                                   `verify_server_starts`, pack, statement

linux-<arch> and alpine-<arch> share one tree: both are `npm ci` with
`npm_config_arch=<arch>` and `core-ci` with `VSCODE_ARCH=<arch>` upstream, and
differ in `remote/node_modules`, which the tree keeps one of each of. Upstream's
Alpine pipeline installs the root without setup-env.sh's sysroot compilers;
here the root natives are built against the 2.28 sysroot either way, and none of
them is in a musl server (`refuse_foreign_binaries` would say so).

On an Apple Silicon Mac the builder runs as amd64 under emulation — Docker
Desktop's Rosetta (Settings > General > "Use Rosetta for x86_64/amd64
emulation") is several times faster than QEMU. Give Docker 8 GB of memory
(`DOCKER_MEMORY_GB`; the script says so up front when `docker info` reports
less, and a step the kernel kills for memory is reported as such): measured
natively on Linux x64, no step peaks above 3.4 GB, once `reh_in_container.sh`
runs upstream's all-at-once extension builds two at a time
(`DEVHUB_BUILD_JOBS`, scripts/reh_build_gate.cjs) with gulp's heap at 4 GB
(`DEVHUB_GULP_HEAP_MB`) — under emulation every process also carries the
emulator's memory, which is what the margin is for.

## The caches, so a rebuild is not an hour

- `~/.cache/devhub/reh/<identity>/` (`$XDG_CACHE_HOME`, `DEVHUB_REH_CACHE`) —
  the finished tarball and statement of each target. A target whose identity
  is cached is verified against its sha256 and copied into `--out-dir`, and
  nothing else happens. `prune_stale` cleans `dist/reh`, never this.
  `--no-cache` ignores it; `--prune-cache [--keep N]` drops all but the N most
  recently used identities (default 2).
- the Docker volume `devhub-reh-work-<arch>` (`DEVHUB_REH_WORK_VOLUME` names
  the prefix) — the tree, with stamps under `.devhub/`: a new VS Code commit is
  a new tree; `npm ci` reruns only when a manifest, a lock file, an `.npmrc`,
  `.nvmrc`, the architecture or the builder image changed; `core-ci` when that
  or the patches, the product metadata or `WORK_REVISION` did; musl's
  `remote/` when the dependencies or the musl image did. A failed target rerun
  costs its own package step. `--reset-work` deletes the volumes.
- `devhub-reh-builder:<hash>` and `devhub-reh-musl:<arch>-<hash>` images, built
  on first use from the Dockerfile text in this file.

    scripts/build_reh.py [linux-x64 linux-arm64 alpine-x64 alpine-arm64]
                         [--out-dir dist/reh] [--no-cache] [--reset-work]
    scripts/build_reh.py --prune-cache [--keep N]

With no targets it builds all four. It needs Docker; the host needs only
python3, git and the `vscode` submodule checked out at the pinned commit.

A target that fails does not stop the run: the tree it was packaged from is
unchanged, so the remaining targets are still built, and every failure is
listed at the end with the command that builds only what is missing. A tree
that fails to prepare does stop it — nothing after it has a tree to build in.

`refuse_foreign_binaries` refuses Mach-O, the other architecture's ELFs and,
on musl, glibc-linked ELFs — except the few vendored helpers upstream's own
servers ship the same way, listed with their reasons in `UPSTREAM_SHIPS`,
which it reports as warnings.

## Natively, on a Linux x64 host without Docker

On a Linux x86-64 machine — upstream's own kind of build agent — `--native`
runs the same `reh_in_container.sh` steps directly on the host, and is chosen
by itself there when Docker is not available: the tree under
`~/.cache/devhub/reh-native/<arch>/` (`DEVHUB_REH_NATIVE_WORK`) instead of a
volume; the host's own `node`, which must be `.nvmrc`'s version; the host's
compilers, `python`, `curl` and upstream's headers (`BUILDER_PACKAGES`); the
glibc check with the tree's sysroot; and the start check run on the host —
`--version`, then a real start until the server says it is listening. It
builds `linux-x64` only: the musl servers need their Alpine containers, and an
arm64 server cannot be started on the host to be checked. `--reset-work`
deletes the native tree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

from product_metadata import PRODUCT_OVERRIDES, packaged_metadata, reh_identity, vscode_commit

REPO_ROOT = Path(__file__).resolve().parent.parent
VSCODE_DIR = REPO_ROOT / "vscode"
REMOTE_DIR = VSCODE_DIR / "remote"
IN_CONTAINER_SCRIPT = REPO_ROOT / "scripts" / "reh_in_container.sh"

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
ARCHES = ("x64", "arm64")

# Bump when a change to reh_in_container.sh or to what this script hands it
# must recompile trees that are otherwise up to date. (A change to the server
# that is shipped bumps REH_REVISION in product_metadata.py instead.)
WORK_REVISION = 2

# The builder image is upstream's Linux agent: Ubuntu 22.04
# (`1es-ubuntu-22.04-x64`), always amd64.
BUILDER_BASE_IMAGE = "ubuntu:22.04"
BUILDER_PLATFORM = "linux/amd64"
# `build/azure-pipelines/dependencies-check.yml`'s headers (minus
# libnotify-bin, which only its tests use), git for the tree, xz for Node, and
# `python` itself: setup-env.sh pipes Chromium's clang updater into `python -`.
BUILDER_PACKAGES = (
	"ca-certificates", "curl", "git", "xz-utils", "python3", "python-is-python3",
	"build-essential", "pkg-config", "libkrb5-dev", "libx11-dev", "libx11-xcb-dev",
	"libxkbfile-dev",
)

EXPECTED_GLIBC_VERSION = "2.28"
EXPECTED_GLIBCXX_VERSION = "3.4.25"
VERIFY_GLIBC_SCRIPT = VSCODE_DIR / "build" / "azure-pipelines" / "linux" / "verify-glibc-requirements.sh"

# The memory Docker needs, in GB as its settings name it. Measured natively
# (Linux x64, 4 CPUs) with reh_in_container.sh's limits, no step peaked above
# 3.4 GB of process memory: npm ci 2.6, the extension builds 3.4 (2.9
# upstream's all-at-once way natively, but some 70 emulated processes at once
# on a Mac), the server bundle 1.8, the Copilot compile 2.9, the package task
# 2.7; each compile step also passed under a 4 GB hard limit (Copilot's, 5).
# 8 GB leaves room for the emulator, Docker's own VM and the page cache.
DOCKER_MEMORY_GB = 8
# `docker info`'s MemTotal is what the VM's kernel has left, a little under
# the setting (8 GB set reads 7.7 GiB): below this the setting is too low.
MIN_DOCKER_MEMORY = int(DOCKER_MEMORY_GB * 0.9 * 1024**3)
# A step killed by the kernel: reh_in_container.sh's `heavy` exits 137
# (128 + SIGKILL), as does `docker run` when its container is; -9 is
# subprocess's own spelling of a SIGKILLed child.
KILLED_STATUSES = (137, -9)
# The host's environment that reaches the builder, by name (`docker run -e
# NAME` passes nothing when NAME is unset): the GitHub token, and
# reh_in_container.sh's memory knobs — how many extension builds at a time
# (default 2) and gulp's heap in MB (default 4096).
PASSED_BY_NAME = ("GITHUB_TOKEN", "DEVHUB_BUILD_JOBS", "DEVHUB_GULP_HEAP_MB")

# Natively (see the docstring): the targets that can be built, and the commands
# the host needs besides the `.nvmrc` Node (flock, util-linux's, for
# reh_build_gate.cjs; ubuntu:22.04 has it as an essential package).
NATIVE_TARGETS = ("linux-x64",)
NATIVE_COMMANDS = ("git", "python", "curl", "make", "g++", "pkg-config", "tar", "xz", "flock")
# Set by `main` when the build runs on the host rather than in Docker.
NATIVE = False


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
	"""VS Code's own name for the task that packages this target's tree.

	`-min` is the bundled-and-minified server; `-ci` is the half of that task
	upstream's pipelines run after `core-ci` has bundled `out-vscode-reh-min`:
	native extensions, the target's Node, the production node_modules, the
	launcher scripts. `product-build-linux-compile.yml` and
	`product-build-alpine.yml` run exactly `core-ci` and then this.
	"""
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	return f"vscode-reh-{gulp_platform}-{gulp_arch}-min-ci"


def gulp_output_name(target: str) -> str:
	"""The tree the task writes beside the VS Code checkout (gulp's BUILD_ROOT)."""
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	return f"vscode-reh-{gulp_platform}-{gulp_arch}"


def docker_platform(target: str) -> str:
	return {"x64": "linux/amd64", "arm64": "linux/arm64"}[arch_of(target)]


def remote_node_version() -> str:
	"""The Node the server runs on and its addons are built against: remote/.npmrc."""
	for line in (REMOTE_DIR / ".npmrc").read_text().splitlines():
		key, _, value = line.partition("=")
		if key.strip() == "target":
			return value.strip().strip('"')
	raise SystemExit(f"no target= in {REMOTE_DIR / '.npmrc'}")


def build_node_version() -> str:
	"""The Node VS Code's build runs on — `.nvmrc`, as upstream's NodeTool step."""
	return (VSCODE_DIR / ".nvmrc").read_text().strip()


def targets_by_arch(targets: list[str] | tuple[str, ...]) -> list[tuple[str, list[str]]]:
	"""The targets grouped by the tree that builds them, in a stable order.

	x64 before arm64, and within an architecture glibc before musl: the glibc
	server packages from the `remote/` install `npm ci` just made, so building
	it first saves one swap of `remote/node_modules`.
	"""
	plan = []
	for arch in ARCHES:
		group = [t for t in TARGETS if t in targets and arch_of(t) == arch]
		group.sort(key=lambda t: libc_of(t) != "glibc")
		if group:
			plan.append((arch, group))
	return plan


# --- images -----------------------------------------------------------------


def node_dist_name(node_version: str) -> str:
	return f"node-v{node_version}-linux-x64"


def builder_dockerfile(node_version: str) -> str:
	"""The image every step on the tree runs in: upstream's Linux agent.

	The Node is the one `.nvmrc` names, from nodejs.org, sha256-checked
	against its SHASUMS256.txt. git is told every directory is safe: the tree
	lives in a volume and is owned by whoever created it.
	"""
	host = node_dist_name(node_version)
	url = f"https://nodejs.org/dist/v{node_version}"
	run = (
		"apt-get update -qq && apt-get install -y -qq --no-install-recommends "
		+ " ".join(BUILDER_PACKAGES)
		+ " >/dev/null && rm -rf /var/lib/apt/lists/*"
		" && cd /tmp"
		f" && curl -fsSLO {url}/{host}.tar.xz"
		f" && curl -fsSL {url}/SHASUMS256.txt | grep ' {host}.tar.xz$' > SHASUMS256.txt"
		" && test -s SHASUMS256.txt && sha256sum -c SHASUMS256.txt"
		f" && tar -xJf {host}.tar.xz -C /usr/local --strip-components=1 --no-same-owner"
		f" && rm {host}.tar.xz SHASUMS256.txt"
		f" && node --version | grep -qx v{node_version}"
		" && git config --system --add safe.directory '*'"
	)
	return f"FROM {BUILDER_BASE_IMAGE}\nENV DEBIAN_FRONTEND=noninteractive\nRUN {run}\n"


def builder_tag(node_version: str) -> str:
	digest = hashlib.sha256(builder_dockerfile(node_version).encode()).hexdigest()[:12]
	return f"devhub-reh-builder:{digest}"


def musl_image(node_version: str) -> str:
	"""The stock image musl's `remote/` is installed in and its `node` taken from."""
	return f"node:{node_version}-alpine"


def musl_dockerfile(node_version: str) -> str:
	"""`node:<version>-alpine` with the compilers `remote/.npmrc`'s
	`build_from_source` needs, and patchelf for `musl_runtime_script` — baked
	in once, so neither the install nor the bundling installs packages again."""
	return (
		f"FROM {musl_image(node_version)}\n"
		"RUN apk add --no-cache python3 make g++ krb5-dev linux-headers patchelf\n"
	)


def musl_tag(target: str, node_version: str) -> str:
	digest = hashlib.sha256(musl_dockerfile(node_version).encode()).hexdigest()[:12]
	return f"devhub-reh-musl:{arch_of(target)}-{digest}"


def ensure_image(tag: str, dockerfile: str, docker_platform_name: str) -> str:
	"""`tag`, built from `dockerfile` for `docker_platform_name` if this machine has not got it."""
	if subprocess.run(["docker", "image", "inspect", tag], capture_output=True).returncode == 0:
		return tag
	print(f"  building image {tag} ({docker_platform_name})")
	built = subprocess.run(
		["docker", "build", "--platform", docker_platform_name, "-t", tag, "-"],
		input=dockerfile.encode(),
	)
	if built.returncode != 0:
		raise SystemExit(
			f"error: building image {tag} failed. Its Dockerfile:\n{dockerfile}\n"
			"If a base image or Node release is missing, check it exists and adjust "
			"builder_dockerfile / musl_dockerfile in scripts/build_reh.py."
		)
	return tag


def ensure_builder() -> str:
	node = build_node_version()
	return ensure_image(builder_tag(node), builder_dockerfile(node), BUILDER_PLATFORM)


def ensure_musl_image(target: str) -> str:
	node = remote_node_version()
	return ensure_image(musl_tag(target, node), musl_dockerfile(node), docker_platform(target))


# --- the containers ---------------------------------------------------------


def work_volume(arch: str) -> str:
	"""The Docker volume holding `arch`'s tree. A volume, not a bind mount: on
	a Mac, `npm ci` into a bind-mounted directory crosses the VM's file sharing
	for every one of a few hundred thousand files."""
	return f"{os.environ.get('DEVHUB_REH_WORK_VOLUME', 'devhub-reh-work')}-{arch}"


def xfer_dir(arch: str) -> Path:
	"""The host directory the containers read inputs from and write tarballs to."""
	return cache_base() / "reh-xfer" / arch


def container_argv(
	image: str,
	docker_platform_name: str,
	shell: str,
	subcommand: str,
	env: dict[str, str],
	*,
	volume: str,
	xfer: Path,
	server: Path | None = None,
) -> list[str]:
	"""`docker run` for one `reh_in_container.sh` subcommand.

	The tree's volume at /build, DevHub's scripts and patches read-only at
	/devhub (apply-vscode-patches.sh finds the patches from its own path),
	the transfer directory at /xfer, and for `verify-glibc` the finished server
	read-only at /server. GITHUB_TOKEN goes through by name, for the rate
	limit of the downloads upstream's steps make from GitHub, and so do the
	memory knobs (`PASSED_BY_NAME`) when set; nothing else of the host's
	environment does.
	"""
	argv = [
		"docker", "run", "--rm", "--platform", docker_platform_name,
		"-v", f"{volume}:/build",
		"-v", f"{REPO_ROOT / 'scripts'}:/devhub/scripts:ro",
		"-v", f"{REPO_ROOT / 'patches'}:/devhub/patches:ro",
		"-v", f"{xfer}:/xfer",
	]
	if server is not None:
		argv += ["-v", f"{server}:/server:ro"]
	for name in PASSED_BY_NAME:
		argv += ["-e", name]
	for key in sorted(env):
		argv += ["-e", f"{key}={env[key]}"]
	argv += [image, shell, "/devhub/scripts/reh_in_container.sh", subcommand]
	return argv


def run_step(argv: list[str], env: dict[str, str] | None = None) -> None:
	subprocess.run(argv, check=True, env=env)


def native_work_dir(arch: str) -> Path:
	"""Natively, the tree that `work_volume(arch)` holds in Docker."""
	override = os.environ.get("DEVHUB_REH_NATIVE_WORK")
	return (Path(override) if override else cache_base() / "reh-native") / arch


def native_builder(node_version: str) -> str:
	"""What stands for the builder image in the tree's dependency stamp."""
	return f"native-{platform.system().lower()}-{platform.machine().lower()}-node{node_version}"


def native_command(
	subcommand: str, env: dict[str, str], *, arch: str, xfer: Path, server: Path | None = None
) -> tuple[list[str], dict[str, str]]:
	"""`reh_in_container.sh <subcommand>` on the host: what `container_argv`
	mounts is passed as paths, and the host's environment goes through."""
	work = native_work_dir(arch)
	work.mkdir(parents=True, exist_ok=True)
	xfer.mkdir(parents=True, exist_ok=True)
	full = dict(os.environ)
	full.update(env)
	full.update({
		"DEVHUB_REH_BUILD": str(work),
		"DEVHUB_REH_XFER": str(xfer),
		"DEVHUB_REH_DEVHUB": str(REPO_ROOT),
	})
	if server is not None:
		full["SERVER"] = str(server)
	return ["bash", str(IN_CONTAINER_SCRIPT), subcommand], full


def tree_step(image: str, subcommand: str, env: dict[str, str], *, arch: str, server: Path | None = None) -> None:
	"""One `reh_in_container.sh` step on `arch`'s tree: in the builder, or natively."""
	xfer = xfer_dir(arch)
	if NATIVE:
		argv, full = native_command(subcommand, env, arch=arch, xfer=xfer, server=server)
		run_step(argv, full)
		return
	run_step(container_argv(
		image, BUILDER_PLATFORM, "bash", subcommand, env, volume=work_volume(arch), xfer=xfer, server=server,
	))


def builder() -> str:
	"""The builder image, or natively what stands for it."""
	return native_builder(build_node_version()) if NATIVE else ensure_builder()


# Fields of the product metadata that change on every run and must not make a
# tree recompile: the build date and DevHub's own commit. Everything else —
# the identity, the overrides, the API proposals — goes into `source_key`.
VOLATILE_METADATA = ("date", "hostCommit")


def source_key(identity: str, metadata: dict[str, object], revision: int = WORK_REVISION) -> str:
	"""What the patched, compiled tree depends on besides its dependencies."""
	stable = {k: v for k, v in metadata.items() if k not in VOLATILE_METADATA}
	payload = json.dumps({"identity": identity, "metadata": stable, "revision": revision}, sort_keys=True)
	return hashlib.sha256(payload.encode()).hexdigest()[:32]


def commit_date(commit: str) -> str:
	return subprocess.run(
		["git", "-C", str(VSCODE_DIR), "show", "-s", "--format=%cI", commit],
		check=True, capture_output=True, text=True,
	).stdout.strip()


def export_source(commit: str, xfer: Path) -> Path:
	"""The pinned commit, as `git archive` has it, for `prepare` to unpack."""
	xfer.mkdir(parents=True, exist_ok=True)
	tarball = xfer / "vscode-src.tar"
	subprocess.run(
		["git", "-C", str(VSCODE_DIR), "archive", "--format=tar", "-o", str(tarball), commit],
		check=True,
	)
	return tarball


def prepare_tree(arch: str, commit: str, key: str, metadata: dict[str, object]) -> float:
	"""Bring `arch`'s tree up to date: source, patches, `npm ci`, `core-ci`."""
	started = time.monotonic()
	image = builder()
	xfer = xfer_dir(arch)
	source = export_source(commit, xfer)
	(xfer / "product-overrides.json").write_text(json.dumps(metadata, indent="\t") + "\n")
	env = {
		"ARCH": arch,
		"BUILDER_IMAGE": image,
		"COMMIT": commit,
		"COMMIT_DATE": commit_date(commit),
		"SOURCE_KEY": key,
	}
	try:
		tree_step(image, "prepare", env, arch=arch)
	finally:
		source.unlink(missing_ok=True)
	return time.monotonic() - started


def install_musl_remote(target: str) -> None:
	"""`remote/` for musl, and the musl `node`, in the target's Alpine image."""
	image = ensure_musl_image(target)
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	env = {
		"ARCH": arch_of(target),
		"GULP_ARCH": gulp_arch,
		"GULP_PLATFORM": gulp_platform,
		"MUSL_IMAGE": image,
		"NODE_VERSION": remote_node_version(),
		"TARGET": target,
	}
	argv = container_argv(
		image, docker_platform(target), "sh", "musl-remote", env,
		volume=work_volume(arch_of(target)), xfer=xfer_dir(arch_of(target)),
	)
	run_step(argv)


def package_target(target: str, commit: str) -> Path:
	"""Run the gulp package task in the tree; the tarball of its output, on the host."""
	gulp_platform, gulp_arch = GULP_TARGETS[target]
	env = {
		"ARCH": arch_of(target),
		"COMMIT": commit,
		"GULP_ARCH": gulp_arch,
		"GULP_PLATFORM": gulp_platform,
		"LIBC": libc_of(target),
		"TARGET": target,
	}
	tree_step(builder(), "package", env, arch=arch_of(target))
	return xfer_dir(arch_of(target)) / f"{target}.tar"


def unpack_staging(target: str, tarball: Path) -> Path:
	"""Unpack the package task's tree next to its tarball, and drop the tarball."""
	root = tarball.parent / target
	shutil.rmtree(root, ignore_errors=True)
	root.mkdir(parents=True)
	subprocess.run(["tar", "-xf", str(tarball), "-C", str(root)], check=True)
	tarball.unlink(missing_ok=True)
	staging = root / gulp_output_name(target)
	if not staging.is_dir():
		raise SystemExit(f"{gulp_task(target)} produced no {gulp_output_name(target)}")
	return staging


def glibc_verify_env(target: str) -> dict[str, str]:
	return {
		"ARCH": arch_of(target),
		"EXPECTED_GLIBCXX_VERSION": EXPECTED_GLIBCXX_VERSION,
		"EXPECTED_GLIBC_VERSION": EXPECTED_GLIBC_VERSION,
		"TARGET": target,
	}


def verify_glibc_floor(staging: Path, target: str) -> None:
	"""Fail if the glibc server needs more than glibc 2.28.

	Upstream's own check, the step after its server build in
	`product-build-linux-compile.yml`: `verify-glibc-requirements.sh` with the
	sysroot's `objdump -T` over every `.node` and `node`, GLIBCXX overshoot only
	warning. Run in the builder against the tree's own sysroot, on the server as
	it ships (Copilot already taken out).
	"""
	if libc_of(target) != "glibc":
		return
	tree_step(builder(), "verify-glibc", glibc_verify_env(target), arch=arch_of(target), server=staging)
	print(f"  {target}: no native code needs more than glibc {EXPECTED_GLIBC_VERSION}")


def verify_image(target: str) -> str:
	"""A plain image of the target's libc to start the finished server in.

	Not the build image: a machine DevHub installs on has no compilers and no
	Node of its own, and a server that only starts where Node is installed is a
	server that depends on something it does not carry. For glibc, Debian 10,
	whose glibc is exactly the 2.28 floor — only pulled and started, never
	`apt`, so its being end-of-life does not matter.
	"""
	return "alpine:3" if libc_of(target) == "musl" else "debian:buster-slim"


def docker_available() -> bool:
	return shutil.which("docker") is not None and subprocess.run(
		["docker", "info"], capture_output=True
	).returncode == 0


def docker_memory() -> int | None:
	result = subprocess.run(["docker", "info", "--format", "{{.MemTotal}}"], capture_output=True, text=True)
	try:
		return int(result.stdout.strip())
	except ValueError:
		return None


def emulated() -> bool:
	"""Whether the amd64 builder runs under emulation on this machine."""
	return platform.machine().lower() not in ("x86_64", "amd64")


def time_note() -> str:
	"""What a person waiting for a build should expect. Natively on a 4-CPU
	Linux x64 machine the first tree took 12 minutes (npm ci 6, the compile 4,
	the server 2); the Apple Silicon figure is an estimate for emulation."""
	where = (
		"amd64 under emulation here; on a Mac turn on Docker Desktop's Rosetta, QEMU is several times slower"
		if emulated() else "native amd64 here"
	)
	return (
		"the first build of an architecture's tree (npm ci + the compile in Linux, "
		f"{where}) takes roughly 15-30 minutes on x64 Linux and 1-2 hours on Apple "
		"Silicon; after that each server is a few minutes, and a server "
		"whose identity is cached is a copy"
	)


def in_container(target: str, image: str, directory: Path, script: str) -> None:
	"""Run `script` in `image` on `target`'s platform, in `directory` mounted at /work.

	The container runs as root, so whatever it wrote is handed back to whoever
	runs this script afterwards, or the next `rm` here is refused.
	"""
	base = ["docker", "run", "--rm", "--platform", docker_platform(target), "-v", f"{directory}:/work", "-w", "/work"]
	subprocess.run([*base, image, "sh", "-c", script], check=True)
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


def prune_cache(identity: str, keep: int, root: Path | None = None) -> list[str]:
	"""Delete all but the `keep` most recently used identities. The current
	identity always stays. The work volumes are not touched (`--reset-work`)."""
	root = root or reh_cache_root()
	removed: list[str] = []
	if root.is_dir():
		dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
		kept = {d.name for d in dirs[:max(keep, 0)]} | {identity}
		for d in dirs:
			if d.name not in kept:
				shutil.rmtree(d)
				removed.append(str(d))
	return removed


def reset_work(arches: list[str] | tuple[str, ...]) -> None:
	for arch in arches:
		if NATIVE:
			where = str(native_work_dir(arch))
			shutil.rmtree(native_work_dir(arch), ignore_errors=True)
		else:
			where = work_volume(arch)
			subprocess.run(["docker", "volume", "rm", "-f", where], check=True, capture_output=True)
		shutil.rmtree(xfer_dir(arch), ignore_errors=True)
		print(f"removed the {arch} build tree ({where})")


# --- the musl C++ runtime ---------------------------------------------------

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
	Out of the same `node:<version>-alpine` the addons were compiled in and
	the `node` came from, so all three agree on the library's version.
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
	in_container(target, ensure_musl_image(target), staging, musl_runtime_script())
	print(f"  bundled libstdc++ and libgcc_s beside {target}'s node")


# --- statements and the bundle ---------------------------------------------


def missing_targets(out_dir: Path, targets: tuple[str, ...] | list[str], commit: str, identity: str) -> list[str]:
	"""The `targets` that have no current server in `out_dir`."""
	return [t for t in targets if bundle_problems(out_dir, commit, identity, required=(t,))]


def retry_command(out_dir: Path, targets: tuple[str, ...] | list[str], commit: str, identity: str) -> str:
	"""The command that builds only what is still missing; built ones stay."""
	todo = missing_targets(out_dir, targets, commit, identity)
	return "scripts/build_reh.py " + " ".join(todo or targets)


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


# --- what DevHub takes out, and what it refuses ------------------------------

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
	build makes cannot reach it — and there is no environment variable or flag
	that turns it off. Nor can the extension simply be left uncompiled: the
	last step of every REH package task is `prepareCopilotRipgrepShimTaskREH`,
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


# `extensions/microsoft-authentication/esbuild.mts` copies the MSAL broker
# runtime into the extension's dist/ by `VSCODE_ARCH` alone (`linuxArches =
# ['x64']`), not by libc — so upstream's own alpine-x64 server, built with
# VSCODE_ARCH=x64, carries the glibc runtime too. musl cannot load it; the
# extension falls back to its non-broker flows, as upstream's linux-arm64 (which
# gets no runtime at all) always does. Only on musl, only these files.
MSAL_FILE = re.compile(r"^(lib)?msal.*\.(node|so)$")


def drop_glibc_msal_runtime(staging: Path, target: str) -> list[str]:
	"""Take the glibc-only MSAL broker runtime out of a musl server."""
	if libc_of(target) != "musl":
		return []
	dist = staging / "extensions" / "microsoft-authentication" / "dist"
	gone = sorted(f.name for f in dist.glob("*") if f.is_file() and MSAL_FILE.match(f.name)) if dist.is_dir() else []
	for name in gone:
		(dist / name).unlink()
	if gone:
		print(f"  {target}: removed upstream's glibc MSAL broker runtime ({', '.join(gone)})")
	return gone


ELF_MACHINES = {"x64": 0x3E, "arm64": 0xB7}
MACHO_MAGICS = (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe")
PE_SUFFIXES = (".node", ".dll", ".exe")

# What a foreign binary is, for the scan and for UPSTREAM_SHIPS below.
MACH_O = "Mach-O"
WRONG_MACHINE = "wrong machine"
GLIBC_ON_MUSL = "glibc on musl"


# --- what upstream ships that cannot run where it is shipped -----------------
#
# The scan below is stricter than upstream: VS Code's own servers carry a few
# vendored helper executables that cannot run on the platform they are in.
# Each one is only ever spawned on demand by an agent/terminal sandbox feature
# (which DevHub turns off with `chat.disableAIFeatures`), looks itself up by
# `process.arch` or `process.platform`, and is never loaded by the server at
# startup. DevHub ships exactly what upstream ships, so these are reported as
# "same as upstream" rather than refused. Anything *not* listed here is still
# fatal: a Mach-O, an ELF of the other machine, or on musl a dynamically
# glibc-linked ELF — `node` and every `*.node` the server loads among them.
#
# Derived from the sources at the pinned commit (2a59476, 1.141.0) and the npm
# packages they pin, because the official tarballs
# (update.code.visualstudio.com/commit:<commit>/server-<platform>/stable) were
# not reachable from where this list was made. Upstream's per-target filters
# (`vscode/build/gulpfile.reh.ts` → `build/lib/copilot.ts`) strip only other
# architectures of @github/copilot-*, @vscode/ripgrep-universal and
# @microsoft/mxc-sdk; nothing filters @vscode/sandbox-runtime, and nothing
# filters by libc. So, per target:
#
#   @vscode/sandbox-runtime@0.0.1 ships one helper, vendor/seccomp/x64/
#   apply-seccomp: a *static* x86-64 glibc executable (it runs on musl as is;
#   its bytes merely contain the string "libc.so.6", which is what tripped the
#   old scan), and no arm64 build at all. Every upstream server carries it,
#   so linux-arm64 and alpine-arm64 carry an x86-64 binary. The package looks
#   for vendor/seccomp/<process.arch>/, finds nothing on arm64, and leaves the
#   seccomp filter off.
#
#   @microsoft/mxc-sdk@0.9.0 bin/<arch>/ is kept for x64 and arm64
#   (`getMxcExcludeFilter`). bin/arm64 mixes platforms: lxc-exec and
#   libmxc_ffi.so (glibc, aarch64) next to mxc-exec-mac, unix-test-proxy and
#   libmxc_ffi.dylib (Mach-O, arm64). So linux-arm64 and alpine-arm64 carry
#   three Mach-O files, and alpine-arm64 two glibc ones. The SDK picks its
#   binary by `process.platform`; libmxc_ffi is loaded only through koffi,
#   which `build/.moduleignore` strips from every server. alpine-x64 is built
#   by the legacy `linux-alpine` task, whose arch `alpine` is not in
#   `mxcArchitectures`, so it gets no mxc binaries at all; linux-x64's
#   bin/x64 (glibc ELFs and Windows PEs) is all runnable or inert there.
#
#   @vscode/ripgrep-universal keeps only bin/linux-<arch>/rg, which is static
#   (static-pie on x64) and runs on musl. Copilot's platform runtime is
#   removed by `remove_copilot`, the glibc MSAL broker runtime on musl by
#   `drop_glibc_msal_runtime`; koffi's per-platform packages are stripped by
#   `.moduleignore`.
#
# (path in the server, the targets upstream ships it to, what is wrong with
# it there, why it is harmless). A test pins this list.
SANDBOX_SECCOMP = "node_modules/@vscode/sandbox-runtime/vendor/seccomp/x64/apply-seccomp"
MXC_ARM64 = "node_modules/@microsoft/mxc-sdk/bin/arm64"
_SECCOMP_WHY = (
	"@vscode/sandbox-runtime ships only an x64 helper; on arm64 it looks in vendor/seccomp/arm64/, "
	"finds nothing and runs without seccomp"
)
_MXC_MAC_WHY = "@microsoft/mxc-sdk's macOS sandbox binaries in its bin/arm64/; chosen by process.platform, never on Linux"
_MXC_GLIBC_WHY = (
	"@microsoft/mxc-sdk's Linux sandbox helper, glibc-only; spawned on demand by the agent sandbox, "
	"libmxc_ffi only through koffi, which no server carries"
)
UPSTREAM_SHIPS: tuple[tuple[str, tuple[str, ...], str, str], ...] = (
	(SANDBOX_SECCOMP, ("linux-arm64", "alpine-arm64"), WRONG_MACHINE, _SECCOMP_WHY),
	(SANDBOX_SECCOMP, ("alpine-x64",), GLIBC_ON_MUSL, "static in 0.0.1, so it runs on musl; were it not, the sandbox it serves is off in DevHub"),
	(f"{MXC_ARM64}/mxc-exec-mac", ("linux-arm64", "alpine-arm64"), MACH_O, _MXC_MAC_WHY),
	(f"{MXC_ARM64}/unix-test-proxy", ("linux-arm64", "alpine-arm64"), MACH_O, _MXC_MAC_WHY),
	(f"{MXC_ARM64}/libmxc_ffi.dylib", ("linux-arm64", "alpine-arm64"), MACH_O, _MXC_MAC_WHY),
	(f"{MXC_ARM64}/lxc-exec", ("alpine-arm64",), GLIBC_ON_MUSL, _MXC_GLIBC_WHY),
	(f"{MXC_ARM64}/libmxc_ffi.so", ("alpine-arm64",), GLIBC_ON_MUSL, _MXC_GLIBC_WHY),
)


def upstream_ships(rel: str, target: str, kind: str) -> str | None:
	"""Why upstream's own `target` server carries `rel` although it is `kind`;
	None when it does not, and the file is DevHub's problem."""
	for path, targets, what, why in UPSTREAM_SHIPS:
		if path == rel and target in targets and what == kind:
			return why
	return None


def _other_platforms_prebuild(rel: Path, target: str) -> bool:
	"""A node-gyp-build `prebuilds/<platform>-<arch>/` directory for some
	*other* platform. Packages ship those for every platform on purpose and
	load only their own (upstream's glibc check skips `*prebuilds*` for the
	same reason). The target's own prebuilds stay checked."""
	parts = rel.parts
	for i, part in enumerate(parts[:-2]):
		if part == "prebuilds":
			return not parts[i + 1].startswith(f"linux-{arch_of(target)}")
	return False


PT_LOAD, PT_DYNAMIC, PT_INTERP = 1, 2, 3
DT_NULL, DT_NEEDED, DT_STRTAB = 0, 1, 5


def elf_links(data: bytes) -> tuple[str | None, list[str]] | None:
	"""An ELF's program interpreter and DT_NEEDED libraries, read from its
	program headers; None when the file cannot be parsed as one. A static
	executable has neither (`([], None)`), however many libc strings its
	bytes happen to contain."""
	try:
		is64 = data[4] == 2
		end = "<" if data[5] == 1 else ">"
		if is64:
			phoff, = struct.unpack_from(end + "Q", data, 0x20)
			phentsize, phnum = struct.unpack_from(end + "HH", data, 0x36)
			ph_fmt, dyn_fmt = end + "IIQQQQQQ", end + "qQ"
		else:
			phoff, = struct.unpack_from(end + "I", data, 0x1C)
			phentsize, phnum = struct.unpack_from(end + "HH", data, 0x2A)
			ph_fmt, dyn_fmt = end + "IIIIIIII", end + "iI"
		loads, interp, dynamic = [], None, None
		for i in range(phnum):
			fields = struct.unpack_from(ph_fmt, data, phoff + i * phentsize)
			if is64:
				p_type, _, p_offset, p_vaddr, _, p_filesz, _, _ = fields
			else:
				p_type, p_offset, p_vaddr, _, p_filesz, _, _, _ = fields
			if p_type == PT_LOAD:
				loads.append((p_vaddr, p_offset, p_filesz))
			elif p_type == PT_INTERP:
				interp = data[p_offset:p_offset + p_filesz].split(b"\0")[0].decode()
			elif p_type == PT_DYNAMIC:
				dynamic = (p_offset, p_filesz)
		needed: list[str] = []
		if dynamic:
			size = struct.calcsize(dyn_fmt)
			offsets, strtab = [], None
			for at in range(dynamic[0], dynamic[0] + dynamic[1] - size + 1, size):
				tag, value = struct.unpack_from(dyn_fmt, data, at)
				if tag == DT_NULL:
					break
				if tag == DT_NEEDED:
					offsets.append(value)
				elif tag == DT_STRTAB:
					strtab = next((value - v + o for v, o, n in loads if v <= value < v + n), None)
			if offsets and strtab is None:
				return None
			for offset in offsets:
				needed.append(data[strtab + offset:].split(b"\0", 1)[0].decode())
		return interp, needed
	except (IndexError, struct.error, UnicodeDecodeError):
		return None


def needs_glibc(data: bytes) -> bool:
	"""Whether this ELF is dynamically linked against glibc: glibc's loader as
	its interpreter, or glibc's sonames among what it needs. An ELF that
	cannot be parsed is judged by whether it names libc.so.6 at all."""
	links = elf_links(data)
	if links is None:
		return b"libc.so.6" in data
	interp, needed = links
	if interp and re.search(r"/ld-linux[^/]*$|/ld64\.so\.[0-9]+$", interp):
		return True
	return any(name == "libc.so.6" or name.startswith("ld-linux") for name in needed)


def scan_binaries(staging: Path, target: str) -> list[tuple[str, str, str, str | None]]:
	"""Every file in the server that cannot run on the target, as
	(path, kind, detail, why upstream ships it or None).

	Mach-O anywhere, an ELF of another machine, and on musl an ELF dynamically
	linked against glibc. By content, not by name: the glibc check only reads
	`*.node` and `node`, and a wrong binary can hide under any name (ripgrep,
	a helper, a .so). PE files are inert on Linux (`windows_binaries`).
	Other platforms' `prebuilds/` are left out entirely.
	"""
	machine = ELF_MACHINES[arch_of(target)]
	found = []
	for path in sorted(staging.rglob("*")):
		if path.is_symlink() or not path.is_file():
			continue
		rel = path.relative_to(staging)
		with path.open("rb") as fh:
			head = fh.read(20)
		kind = detail = None
		if head[:4] in MACHO_MAGICS or (head[:4] == b"\xca\xfe\xba\xbe" and 0 < int.from_bytes(head[4:8], "big") < 30):
			kind, detail = MACH_O, "Mach-O (macOS)"
		elif head[:2] == b"MZ":
			# Inert on Linux: nothing loads a PE there. Upstream's own Linux
			# servers carry these (js-debug's win32-*.node natives, loaded only
			# on win32; PSReadLine DLLs for PowerShell shell integration;
			# @microsoft/mxc-sdk's Windows sandbox binaries). See windows_binaries.
			continue
		elif head[:4] == b"\x7fELF" and len(head) >= 20:
			got = int.from_bytes(head[18:20], "little" if head[5] == 1 else "big")
			if got != machine:
				kind, detail = WRONG_MACHINE, f"ELF for machine {got:#x}, not {machine:#x}"
			elif libc_of(target) == "musl" and needs_glibc(path.read_bytes()):
				kind, detail = GLIBC_ON_MUSL, "glibc ELF on a musl target"
		if kind and not _other_platforms_prebuild(rel, target):
			found.append((rel.as_posix(), kind, detail, upstream_ships(rel.as_posix(), target, kind)))
	return found


def foreign_binaries(staging: Path, target: str) -> list[str]:
	"""The binaries that make the server unfit to ship: those `scan_binaries`
	finds that upstream does not ship the same way (`UPSTREAM_SHIPS`)."""
	return [f"{rel}: {detail}" for rel, _, detail, why in scan_binaries(staging, target) if why is None]


def windows_binaries(staging: Path) -> list[str]:
	"""PE files in the server: inert on Linux, and shipped by upstream too."""
	found = []
	for path in sorted(staging.rglob("*")):
		if path.is_symlink() or not path.is_file() or path.suffix.lower() not in PE_SUFFIXES:
			continue
		with path.open("rb") as fh:
			if fh.read(2) == b"MZ":
				found.append(str(path.relative_to(staging)))
	return found


def refuse_foreign_binaries(staging: Path, target: str) -> None:
	pe = windows_binaries(staging)
	if pe:
		print(f"  {target}: info: {len(pe)} Windows PE file(s) left in place (never loaded on Linux; upstream ships them too)")
	found = scan_binaries(staging, target)
	for rel, kind, _, why in found:
		if why is not None:
			print(f"  {target}: warning: {rel}: {kind}, same as upstream's own {target} server; {why}")
	problems = [f"{rel}: {detail}" for rel, _, detail, why in found if why is None]
	if problems:
		raise SystemExit(
			f"{target}: the server carries binaries that cannot run there:\n  "
			+ "\n  ".join(problems)
		)
	shipped = sum(1 for *_, why in found if why is not None)
	print(
		f"  {target}: every binary in the server is for {target}"
		+ (f", but for {shipped} helper(s) upstream ships the same way (UPSTREAM_SHIPS)" if shipped else "")
	)


def verify_server_starts(staging: Path, target: str) -> None:
	"""Start the server that was just carved up, offline, where it will run.

	In a plain container of the target's libc and architecture with no network
	(`--network none`): no compilers, no Node, no route out — the machine this
	server is for, as far as starting it is concerned. `--version` loads
	`server-main.js`, which is where the product metadata, the
	`copilotVersions` lookup and the module resolution that `remove_copilot`
	could plausibly have broken all happen, and it runs the target's own `node`
	on the target's own libc, which is the thing a wrong build gets wrong.
	"""
	launcher = f"bin/{PRODUCT_OVERRIDES['serverApplicationName']}"
	if NATIVE:
		verify_server_starts_natively(staging, target, launcher)
		return
	argv = [
		"docker", "run", "--rm", "--network", "none",
		"--platform", docker_platform(target),
		"-v", f"{staging}:/reh:ro",
		verify_image(target),
		f"/reh/{launcher}", "--version",
	]
	result = subprocess.run(argv, capture_output=True, text=True, timeout=300)
	if result.returncode != 0:
		raise SystemExit(
			f"the {target} server did not start ({' '.join(argv)} exited "
			f"{result.returncode}):\n{result.stdout}{result.stderr}"
		)
	print(f"  {target} {launcher} --version: {result.stdout.strip().splitlines()[0]}")


def native_start_env() -> dict[str, str]:
	"""Nothing of the host's environment that could hand the server a Node or
	modules it does not carry: the system PATH only, and a HOME of nobody's."""
	return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8"}


def verify_server_starts_natively(staging: Path, target: str, launcher: str) -> None:
	"""Natively: the server's own launcher and `node` on the host's glibc,
	`--version`, then a real start that must say it is listening."""
	env = native_start_env()
	result = subprocess.run([str(staging / launcher), "--version"], capture_output=True, text=True, timeout=300, env=env)
	if result.returncode != 0:
		raise SystemExit(
			f"the {target} server did not start ({staging / launcher} --version exited "
			f"{result.returncode}):\n{result.stdout}{result.stderr}"
		)
	print(f"  {target} {launcher} --version: {result.stdout.strip().splitlines()[0]}")
	listening = server_listens(staging / launcher, env)
	if listening is None:
		raise SystemExit(f"the {target} server started but never said it was listening")
	print(f"  {target}: {listening}")


def server_listens(launcher: Path, env: dict[str, str], timeout: float = 120) -> str | None:
	"""Start the server on a free local port, wait for its "listening on"
	line, and stop it. The line, or None if it exited or took too long."""
	with tempfile.TemporaryDirectory() as data:
		argv = [
			str(launcher), "--host", "127.0.0.1", "--port", "0", "--without-connection-token",
			"--accept-server-license-terms", "--server-data-dir", data,
		]
		proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
		timer = threading.Timer(timeout, proc.kill)
		timer.start()
		try:
			assert proc.stdout is not None
			for line in proc.stdout:
				if "listening on" in line.lower():
					return line.strip()
			return None
		finally:
			timer.cancel()
			proc.terminate()
			try:
				proc.wait(timeout=10)
			except subprocess.TimeoutExpired:
				proc.kill()
				proc.wait()
			if proc.stdout is not None:
				proc.stdout.close()


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


# The host's post-steps, in order. A test pins it.
POST_STEPS = (
	"remove_copilot",
	"drop_glibc_msal_runtime",
	"bundle_musl_runtime",
	"refuse_foreign_binaries",
	"verify_glibc_floor",
	"verify_server_starts",
)


def build_target(target: str, commit: str, identity: str, out_dir: Path) -> Path:
	"""Package one target in its tree, then trim, check, tar and state it."""
	started = time.monotonic()
	if libc_of(target) == "musl":
		install_musl_remote(target)
	staging = unpack_staging(target, package_target(target, commit))
	try:
		module = sys.modules[__name__]
		for name in POST_STEPS:
			getattr(module, name)(staging, target)
		tarball = out_dir / tarball_name(target)
		pack(staging, tarball, top_level_dir(target))
	finally:
		shutil.rmtree(staging.parent, ignore_errors=True)
	write_statement(out_dir, target, commit, identity)
	store_cached_server(target, identity, out_dir)
	size_mb = tarball.stat().st_size / 1e6
	print(f"{tarball.name}: {size_mb:.0f} MB, packaged in {(time.monotonic() - started) / 60:.0f} min")
	return tarball


def require_commit(commit: str) -> None:
	"""The host only needs the submodule's objects: `git archive` reads them."""
	have = subprocess.run(
		["git", "-C", str(VSCODE_DIR), "cat-file", "-e", f"{commit}^{{commit}}"], capture_output=True
	)
	if have.returncode != 0:
		raise SystemExit(
			f"the vscode submodule does not have commit {commit}: run scripts/vscode-submodule.sh sync"
		)


def native_host() -> bool:
	"""Whether this machine can build natively: Linux on x86-64."""
	return platform.system() == "Linux" and platform.machine().lower() in ("x86_64", "amd64")


def native_refusal(targets: list[str]) -> str | None:
	"""Why these targets cannot be built natively here; None when they can."""
	if not native_host():
		return "--native builds only on a Linux x86-64 host; elsewhere build_reh.py needs Docker"
	other = [t for t in targets if t not in NATIVE_TARGETS]
	if other:
		return (
			f"{', '.join(other)} cannot be built natively ({', '.join(NATIVE_TARGETS)} only: the musl "
			"servers are installed in Alpine containers, and an arm64 server cannot be started here "
			"to be checked). Build them with Docker."
		)
	return None


def native_problems() -> list[str]:
	"""What the host lacks for a native build: `.nvmrc`'s Node and the tools."""
	problems = []
	want = build_node_version()
	try:
		have = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
	except OSError:
		have = "none"
	if have != f"v{want}":
		problems.append(f"node on PATH is {have or 'none'}, and VS Code builds with v{want} (vscode/.nvmrc)")
	missing = [c for c in NATIVE_COMMANDS if shutil.which(c) is None]
	if missing:
		problems.append(
			f"missing {', '.join(missing)}; upstream's agent has the packages {' '.join(BUILDER_PACKAGES)}"
		)
	return problems


RAISE_DOCKER_MEMORY = (
	"Docker Desktop: Settings > Resources > Memory; Rancher Desktop: Preferences > "
	"Virtual Machine > Memory; colima: `colima start --memory {gb}`"
)


def docker_memory_problem(memory: int | None) -> str | None:
	"""What to say about Docker's memory before a build; None when it is enough
	or `docker info` did not say."""
	if memory is None or memory >= MIN_DOCKER_MEMORY:
		return None
	return (
		f"warning: Docker's VM has {memory / 1024**3:.1f} GB of memory and building the servers "
		f"needs {DOCKER_MEMORY_GB} GB; with less, a step is likely to be killed for memory. Raise it "
		f"to {DOCKER_MEMORY_GB} GB ({RAISE_DOCKER_MEMORY.format(gb=DOCKER_MEMORY_GB)}) and run this again."
	)


def killed_message(error: BaseException, native: bool) -> str | None:
	"""What a step killed by the kernel means; None for any other failure."""
	if not isinstance(error, subprocess.CalledProcessError) or error.returncode not in KILLED_STATUSES:
		return None
	if native:
		return (
			f"killed (out of memory): this machine needs about {DOCKER_MEMORY_GB} GB of memory free "
			"for the build; close what else is running and retry."
		)
	return (
		f"killed (out of memory): raise Docker memory to {DOCKER_MEMORY_GB} GB "
		f"({RAISE_DOCKER_MEMORY.format(gb=DOCKER_MEMORY_GB)}) and retry."
	)


def warn_about_docker() -> None:
	problem = docker_memory_problem(docker_memory())
	if problem:
		print(problem, file=sys.stderr)
	print(f"  note: {time_note()}")


def report_failures(
	failures: list[tuple[str, BaseException]], out_dir: Path, targets: list[str], commit: str, identity: str
) -> None:
	"""Every failure of this run, then what is left and how to build only that."""
	remaining = retry_command(out_dir, targets, commit, identity) + (" --native" if NATIVE else "")
	lines = [f"\n{len(failures)} failure(s):"]
	for failed, error in failures:
		lines.append(f"  {failed}: {error}")
		killed = killed_message(error, NATIVE)
		if killed:
			lines.append(f"    {killed}")
	trees = ", ".join(
		str(native_work_dir(arch)) if NATIVE else f"the Docker volume {work_volume(arch)}"
		for arch, _ in targets_by_arch(targets)
	)
	lines.append(
		f"Servers already built stay in {out_dir}, and the trees ({trees}) keep every step that "
		f"finished. Retry only what is missing with:\n  {remaining}"
	)
	print("\n".join(lines), file=sys.stderr)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("targets", nargs="*", help=f"any of {', '.join(TARGETS)}; default: all four")
	parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
	parser.add_argument("--no-cache", action="store_true", help="build even targets the server cache has")
	parser.add_argument("--reset-work", action="store_true", help="delete the build trees of these targets' architectures first")
	parser.add_argument("--native", action="store_true", help=f"build on this Linux x64 host without Docker ({', '.join(NATIVE_TARGETS)} only)")
	parser.add_argument("--prune-cache", action="store_true", help="clean the server cache and exit")
	parser.add_argument("--keep", type=int, default=2, help="with --prune-cache: identities to keep (default 2)")
	args = parser.parse_args()
	if args.prune_cache:
		for gone in prune_cache(reh_identity(), args.keep):
			print(f"removed {gone}")
		return 0
	targets = args.targets or list(TARGETS)
	unknown = [target for target in targets if target not in TARGETS]
	if unknown:
		parser.error(f"no such target: {', '.join(unknown)} (DevHub carries {', '.join(TARGETS)})")

	global NATIVE
	NATIVE = args.native or (not docker_available() and native_host())
	if NATIVE:
		refusal = native_refusal(targets)
		if refusal:
			raise SystemExit(refusal)
		if not args.native:
			print("Docker is not available; building natively on this Linux x64 host (--native)")
	elif not docker_available():
		raise SystemExit(
			"build_reh.py needs Docker: the servers are built in Linux containers, the "
			"way VS Code builds its own, and each is started in one before it is packed. "
			"Start Docker (Docker Desktop, colima, or dockerd) and run this again."
		)

	commit = vscode_commit()
	identity = reh_identity()
	out_dir: Path = args.out_dir.resolve()
	out_dir.mkdir(parents=True, exist_ok=True)
	print(f"remote extension hosts for VS Code {commit}, identity {identity}: {', '.join(targets)}")
	for target in prune_stale(out_dir, identity):
		print(f"  removed the {target} server built from another identity")
	if args.reset_work:
		reset_work([arch for arch, _ in targets_by_arch(targets)])

	if not args.no_cache:
		cached = [t for t in targets if restore_cached_server(t, commit, identity, out_dir)]
		for target in cached:
			print(f"  {target}: restored from {reh_cache_root() / identity}")
		targets = [t for t in targets if t not in cached]
		if not targets:
			return 0

	require_commit(commit)
	if NATIVE:
		problems = native_problems()
		if problems:
			raise SystemExit("cannot build natively here:\n  " + "\n  ".join(problems))
	else:
		warn_about_docker()
	if not os.environ.get("GITHUB_TOKEN"):
		print(
			"  note: GITHUB_TOKEN is not set. The sysroot download and npm ci's postinstalls "
			"(@vscode/ripgrep) use GitHub's API, 60 requests an hour without a token; if npm ci "
			"fails with a 403, set it (e.g. GITHUB_TOKEN=$(gh auth token)) and run this again."
		)
	metadata = packaged_metadata()
	key = source_key(identity, metadata)
	failures: list[tuple[str, BaseException]] = []
	for arch, group in targets_by_arch(targets):
		try:
			elapsed = prepare_tree(arch, commit, key, metadata)
			print(f"the {arch} tree is ready ({elapsed / 60:.0f} min)")
		except (subprocess.CalledProcessError, SystemExit) as error:
			# Every target after this one needs a tree, and the next
			# architecture's would most likely fail the same way (memory,
			# network, a patch): stop here.
			failures.append((f"the {arch} tree", error))
			break
		for target in group:
			try:
				build_target(target, commit, identity, out_dir)
			except (subprocess.CalledProcessError, SystemExit) as error:
				# The tree is still good — packaging and the host's checks only
				# read it — so the other targets go on, and every failure is
				# reported together at the end.
				print(f"\nerror: {target} failed ({error}); going on with the rest.", file=sys.stderr)
				failures.append((target, error))
	if failures:
		report_failures(failures, out_dir, targets, commit, identity)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
