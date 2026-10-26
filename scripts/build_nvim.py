#!/usr/bin/env python3
"""Fetch the Neovim DevHub carries to the machines it works on.

Terminal mode (`docs/terminal-mode.md`) gives an SSH Workspace an editor
area that is the host's own tmux session, and a Neovim DevHub manages there
for file jumps. The host is not asked to have one: DevHub brings it, the way
it brings tmux and the remote extension host. This script puts the Neovims in
the bundle, at build time:

    DevHub.app/Contents/Resources/nvim/
      nvim.json                         the statement: version, and per target
                                        the file, its sha256, the directory
                                        inside it and the glibc it needs
      nvim-<version>-linux-x64.tar.gz   one tarball per Linux architecture,
      nvim-<version>-linux-arm64.tar.gz byte for byte the release asset

DevHub copies the one a host needs over its existing connection, from these
bytes; the host never reaches the network for it (see `tmuxDelivery.ts`,
"this Mac fetches; the host receives").

## Which Neovim

The owner's own builds, https://github.com/statiolake/neovim-binaries: the
upstream release tags built by upstream's own CMake + cpack recipe on Debian
stretch, so they link a glibc old enough for nearly any Linux still running
(2.14 symbols on x86_64, 2.17 on aarch64 — the first aarch64 glibc). The
official `nvim-linux-*.tar.gz` asks for 2.31, which leaves out CentOS 7, the
Ubuntu 18.04 boxes and the NAS images this feature is for. A plain directory
tree, not an AppImage, so nothing needs FUSE.

They are glibc builds. A musl host (Alpine) cannot run them, and DevHub says
so and falls back to the host's own `nvim` (`editor/neovimTerraform.ts`).

## Pinned, verified, cached

Each target is pinned by the release tag *and* the sha256 of its asset; a
download that does not hash to the pin is deleted, not used. The glibc the
binary asks for is pinned too, and checked against the binary's own symbol
versions, so a rebuilt asset under the same tag cannot quietly raise the
floor DevHub promises. Downloads are cached under `~/.cache/devhub/nvim/`
(`$XDG_CACHE_HOME`; `DEVHUB_NVIM_CACHE` overrides), so a second build is a
copy.

    scripts/build_nvim.py [--out-dir dist/nvim] [--no-cache]
    scripts/build_nvim.py --check DIR

Runs on any machine: nothing is compiled.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "dist" / "nvim"

RELEASES = "https://github.com/statiolake/neovim-binaries/releases/download"
NEOVIM_VERSION = "v0.12.6"
STATEMENT = "nvim.json"


class Target(NamedTuple):
	# The release asset's name.
	asset: str
	sha256: str
	# The single directory inside the archive.
	top_level_directory: str
	# The newest GLIBC_x.y symbol version the binary asks for.
	glibc: str


TARGETS: dict[str, Target] = {
	"linux-x64": Target(
		"nvim-linux-x86_64.tar.gz",
		"4fd829840a19ba36133a24b0a76bcdf90d6e4606639cf4ee9856895b25c24b9f",
		"nvim-linux-x86_64",
		"2.14",
	),
	"linux-arm64": Target(
		"nvim-linux-arm64.tar.gz",
		"7e5f37885b9d185fafb89d059c3495a64e45714975b6e4b8c1bfa36932c72b00",
		"nvim-linux-arm64",
		"2.17",
	),
}


# --- pure ---------------------------------------------------------------------


def asset_url(target: str, version: str = NEOVIM_VERSION) -> str:
	return f"{RELEASES}/{version}/{TARGETS[target].asset}"


def bundle_name(target: str, version: str = NEOVIM_VERSION) -> str:
	"""The tarball's name in the bundle."""
	return f"nvim-{version}-{target}.tar.gz"


def statement(version: str = NEOVIM_VERSION) -> dict[str, object]:
	"""What `nvim.json` says, and what `install_problems` holds a directory to."""
	return {
		"version": version,
		"source": f"https://github.com/statiolake/neovim-binaries/releases/tag/{version}",
		"targets": {
			name: {
				"file": bundle_name(name, version),
				"sha256": target.sha256,
				"topLevelDirectory": target.top_level_directory,
				"glibc": target.glibc,
			}
			for name, target in TARGETS.items()
		},
	}


GLIBC_SYMBOL = re.compile(rb"GLIBC_(\d+)\.(\d+)(?:\.(\d+))?\x00")


def newest_glibc(binary: bytes) -> str | None:
	"""The newest `GLIBC_x.y[.z]` version an ELF's dynamic strings name.

	The version needs live in `.dynstr` as NUL-terminated names; scanning the
	whole file for them is what `objdump -T | grep GLIBC_` reads, without
	needing a binutils that understands ELF on the Mac that packages.
	"""
	found = [
		tuple(int(part) for part in match.groups() if part is not None)
		for match in GLIBC_SYMBOL.finditer(binary)
	]
	if not found:
		return None
	return ".".join(str(part) for part in max(found))


def tarball_problems(target: str, data: bytes) -> list[str]:
	"""Why `data` is not the pinned asset for `target`; empty when it is."""
	pin = TARGETS[target]
	digest = hashlib.sha256(data).hexdigest()
	if digest != pin.sha256:
		return [f"{pin.asset} hashes to {digest}, not the pinned {pin.sha256}"]
	try:
		with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
			names = archive.getnames()
			top = {name.split("/", 1)[0] for name in names}
			if top != {pin.top_level_directory}:
				return [f"{pin.asset} holds {sorted(top)}, not one {pin.top_level_directory}/"]
			member = archive.extractfile(f"{pin.top_level_directory}/bin/nvim")
			if member is None:
				return [f"{pin.asset} has no bin/nvim"]
			binary = member.read()
	except (tarfile.TarError, KeyError, OSError) as error:
		return [f"{pin.asset} is not a readable tarball: {error}"]
	glibc = newest_glibc(binary)
	if glibc != pin.glibc:
		return [f"{pin.asset}'s nvim asks for glibc {glibc}, not the pinned {pin.glibc}"]
	return []


def hash_file(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as handle:
		while chunk := handle.read(1 << 20):
			digest.update(chunk)
	return digest.hexdigest()


def install_problems(directory: Path) -> list[str]:
	"""Why `directory` is not the Neovims to bundle; empty when it is."""
	try:
		said = json.loads((directory / STATEMENT).read_text())
	except (OSError, ValueError):
		return [f"no readable {directory / STATEMENT}"]
	if said != statement():
		return [f"{directory / STATEMENT} is not the statement of Neovim {NEOVIM_VERSION} as pinned here"]
	problems = []
	for name in TARGETS:
		path = directory / bundle_name(name)
		if not path.is_file():
			problems.append(f"{path} is missing")
		elif hash_file(path) != TARGETS[name].sha256:
			problems.append(f"{path} does not hash to its pin")
	stray = sorted(
		entry.name
		for entry in directory.iterdir()
		if entry.name != STATEMENT and entry.name not in {bundle_name(name) for name in TARGETS}
	)
	if stray:
		problems.append(f"{directory} also holds {', '.join(stray)}, which would be bundled for nothing")
	return problems


# --- effects ------------------------------------------------------------------


def cache_root() -> Path:
	override = os.environ.get("DEVHUB_NVIM_CACHE")
	if override:
		return Path(override)
	xdg = os.environ.get("XDG_CACHE_HOME")
	return (Path(xdg) if xdg else Path.home() / ".cache") / "devhub" / "nvim"


def say(message: str) -> None:
	print(f"==> {message}", file=sys.stderr, flush=True)


def fail(message: str) -> "None":
	print(f"\nbuild_nvim.py: {message}", file=sys.stderr)
	raise SystemExit(1)


def download(url: str) -> bytes:
	with urllib.request.urlopen(url, timeout=120) as response:
		return response.read()


def ensure_asset(target: str, root: Path, *, use_cache: bool = True, fetch=download) -> Path:
	"""The pinned asset for `target` in the cache, downloaded and verified if it is not."""
	cached = root / NEOVIM_VERSION / TARGETS[target].asset
	if use_cache and cached.is_file():
		problems = tarball_problems(target, cached.read_bytes())
		if not problems:
			return cached
		say(f"cached {cached.name} unusable ({problems[0]}); downloading again")
	url = asset_url(target)
	say(f"downloading Neovim {NEOVIM_VERSION} for {target} from {url}")
	try:
		data = fetch(url)
	except OSError as error:
		fail(f"could not download {url}: {error}")
	problems = tarball_problems(target, data)
	if problems:
		fail("; ".join(problems))
	cached.parent.mkdir(parents=True, exist_ok=True)
	partial = cached.with_name(cached.name + ".part")
	partial.write_bytes(data)
	partial.replace(cached)
	return cached


def install(out_dir: Path, *, use_cache: bool = True, fetch=download) -> None:
	"""Put both tarballs and their statement in `out_dir`, and nothing else."""
	root = cache_root()
	sources = {name: ensure_asset(name, root, use_cache=use_cache, fetch=fetch) for name in TARGETS}
	if out_dir.exists():
		shutil.rmtree(out_dir)
	out_dir.mkdir(parents=True)
	for name, source in sources.items():
		partial = out_dir / (bundle_name(name) + ".part")
		shutil.copyfile(source, partial)
		partial.replace(out_dir / bundle_name(name))
	(out_dir / STATEMENT).write_text(json.dumps(statement(), indent="\t") + "\n")


def ensure(out_dir: Path = DEFAULT_OUT_DIR) -> int:
	"""Install into `out_dir` unless what is there is already right. For package-nightly.py."""
	if not install_problems(out_dir):
		return 0
	install(out_dir)
	problems = install_problems(out_dir)
	for problem in problems:
		print(f"  {problem}", file=sys.stderr)
	return 1 if problems else 0


def main(argv: list[str]) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
	parser.add_argument("--no-cache", action="store_true", help="download again")
	parser.add_argument("--check", metavar="DIR", help="only say what is wrong with DIR")
	args = parser.parse_args(argv)
	if args.check:
		problems = install_problems(Path(args.check))
		for problem in problems:
			print(problem)
		return 1 if problems else 0
	out_dir = Path(args.out_dir).resolve()
	install(out_dir, use_cache=not args.no_cache)
	problems = install_problems(out_dir)
	if problems:
		fail("; ".join(problems))
	say(f"Neovim {NEOVIM_VERSION} ready in {out_dir}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
